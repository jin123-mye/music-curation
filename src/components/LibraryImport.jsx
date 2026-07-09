import { useState, useRef } from 'react'
import { glass, glassDark, getTheme, getDarkTheme, GLOBAL_CSS } from '../styles/theme'

// 취향 그래프 막대 색상 팔레트
const BAR_COLORS = ['#7C5CFF', '#FF4D8D', '#4090e0', '#30b070', '#e0a030', '#e05040', '#9060d0', '#20b0a0']

// 파일 → base64 (data URL 접두어 제거)
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] || '')
  r.onerror = reject
  r.readAsDataURL(file)
})

// title+artist 기준 중복 제거
const dedupe = (list) => {
  const seen = new Set()
  return list.filter(s => {
    const k = `${(s.title || '').toLowerCase().trim()}|${(s.artist || '').toLowerCase().trim()}`
    if (!k.replace('|', '') || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const GEMINI_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`

export default function LibraryImport({
  isDark = false, emotion = 'default', onBack, onPlaySong,
  onSaveImported, onSaveTasteProfile, onSaveTaste,
}) {
  const [step, setStep]       = useState('upload')   // 'upload' | 'review' | 'result'
  const [images, setImages]   = useState([])         // { url, base64, mime }
  const [songs, setSongs]     = useState([])         // 추출된 곡 [{title, artist}]
  const [profile, setProfile] = useState(null)       // 취향 분석 결과
  const [busy, setBusy]       = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError]     = useState('')
  const fileRef = useRef(null)

  const theme = isDark ? getDarkTheme(emotion) : getTheme(emotion)
  const G     = isDark ? glassDark : glass
  const tc    = isDark ? '#c0c8f0' : '#1a2a4a'
  const sc    = isDark ? 'rgba(180,190,255,0.50)' : 'rgba(20,40,90,0.50)'
  const border = isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(100,120,200,0.25)'

  // ── 이미지 선택 ────────────────────────────────────────────
  const handleFiles = async (fileList) => {
    setError('')
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/')).slice(0, 5 - images.length)
    if (files.length === 0) return
    const added = []
    for (const f of files) {
      try {
        added.push({ url: URL.createObjectURL(f), base64: await fileToBase64(f), mime: f.type })
      } catch (_) { /* 개별 실패는 건너뜀 */ }
    }
    setImages(prev => [...prev, ...added].slice(0, 5))
  }

  const removeImage = (i) => setImages(prev => prev.filter((_, idx) => idx !== i))

  // ── 1단계: 스크린샷 → 곡 목록 추출 (Gemini 비전) ──────────────
  const extractSongs = async () => {
    if (images.length === 0) return
    setBusy(true); setError('')
    const KEY = import.meta.env.VITE_GEMINI_KEY
    const prompt = [
      '이 이미지는 음악 앱(멜론·스포티파이·유튜브뮤직·애플뮤직 등)의 보관함/재생목록 스크린샷이야.',
      '보이는 모든 노래의 제목과 아티스트를 정확히 읽어서 JSON 배열로만 반환해줘. 마크다운·설명 없이 JSON만.',
      '[{"title":"노래제목","artist":"아티스트명"}]',
      '- 광고·메뉴·버튼 텍스트는 제외하고 실제 곡만.',
      '- 아티스트를 못 읽으면 artist는 "".',
    ].join('\n')

    try {
      let collected = []
      for (let i = 0; i < images.length; i++) {
        setProgress(`스크린샷 분석 중… (${i + 1}/${images.length})`)
        const res = await fetch(GEMINI_URL(KEY), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: images[i].mime, data: images[i].base64 } },
              ],
            }],
          }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error.message)
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]'
        try {
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
          if (Array.isArray(parsed)) collected = collected.concat(parsed)
        } catch (_) { /* 한 장 파싱 실패는 무시하고 계속 */ }
      }

      const clean = dedupe(collected)
        .map(s => ({ title: (s.title || '').trim(), artist: (s.artist || '').trim() }))
        .filter(s => s.title)

      if (clean.length === 0) {
        setError('곡을 읽지 못했어요. 목록이 또렷하게 보이는 스크린샷으로 다시 시도해 주세요.')
      } else {
        setSongs(clean)
        setStep('review')
      }
    } catch (e) {
      console.error('곡 추출 실패:', e)
      setError('분석 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.')
    } finally {
      setBusy(false); setProgress('')
    }
  }

  // ── 곡 목록 수동 편집 ───────────────────────────────────────
  const editSong = (i, field, value) =>
    setSongs(prev => prev.map((s, idx) => idx === i ? { ...s, [field]: value } : s))
  const removeSong = (i) => setSongs(prev => prev.filter((_, idx) => idx !== i))

  // ── 2단계: 보관함 저장 + 취향 분석 ───────────────────────────
  const analyzeTaste = async () => {
    const valid = songs.filter(s => s.title.trim())
    if (valid.length === 0) return
    setBusy(true); setError(''); setProgress('취향을 분석하고 있어요…')
    const KEY = import.meta.env.VITE_GEMINI_KEY

    // youtubeQuery 부여 후 보관함에 저장 (재생 가능하도록)
    const withQuery = valid.map(s => ({
      title: s.title, artist: s.artist,
      youtubeQuery: `${s.title} ${s.artist}`.trim(),
    }))
    onSaveImported?.(withQuery)

    const list = valid.slice(0, 60).map(s => `- ${s.title} / ${s.artist || '미상'}`).join('\n')
    const prompt = `
아래는 사용자의 음악 보관함 곡 목록이야:
${list}

이 목록을 바탕으로 사용자의 음악 취향을 분석해줘. JSON만 반환. 마크다운 금지.
{
  "genres":[{"name":"장르명(한글)","percent":정수}],
  "genreKeys":["kpop","ballad","hiphop","rnb","indie","dance","trot","ost","lofi","classic 중 해당하는 것만"],
  "moods":[{"name":"분위기 한 단어","percent":정수}],
  "topArtists":["대표 아티스트","..."],
  "era":"주로 듣는 시대 (예: 2010년대, 2020년대, 다양함)",
  "energy":0부터100사이정수,
  "summary":"사용자의 취향을 2~3문장으로 따뜻하게 요약"
}
- genres는 비중 큰 순 최대 5개, percent 합은 100 근처.
- moods 최대 4개, topArtists 최대 6명, genreKeys 최대 4개.
`.trim()

    try {
      const res = await fetch(GEMINI_URL(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
      const p = JSON.parse(raw.replace(/```json|```/g, '').trim())

      const result = {
        genres: Array.isArray(p.genres) ? p.genres.slice(0, 5) : [],
        genreKeys: Array.isArray(p.genreKeys) ? p.genreKeys.slice(0, 4) : [],
        moods: Array.isArray(p.moods) ? p.moods.slice(0, 4) : [],
        topArtists: Array.isArray(p.topArtists) ? p.topArtists.slice(0, 6) : [],
        era: p.era || '다양함',
        energy: Math.max(0, Math.min(100, Number(p.energy) || 50)),
        summary: p.summary || '',
        songCount: valid.length,
      }
      setProfile(result)
      onSaveTasteProfile?.(result)
      // 기존 취향(추천 프롬프트에 사용)에도 반영
      onSaveTaste?.(result.genreKeys, result.topArtists)
      setStep('result')
    } catch (e) {
      console.error('취향 분석 실패:', e)
      setError('취향 분석 중 오류가 발생했어요. 곡은 보관함에 저장됐어요. 다시 시도해 주세요.')
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const reset = () => {
    setImages([]); setSongs([]); setProfile(null); setError(''); setStep('upload')
  }

  // ── 공통 헤더 ──────────────────────────────────────────────
  const Header = ({ title, desc }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28 }}>
      <button onClick={onBack} style={{
        background: 'none', border, borderRadius: 12, padding: '8px 16px',
        color: sc, cursor: 'pointer', fontSize: 13,
      }}>← 돌아가기</button>
      <div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: tc, margin: 0 }}>{title}</h2>
        <p style={{ fontSize: 13, color: sc, margin: '4px 0 0' }}>{desc}</p>
      </div>
    </div>
  )

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{
        minHeight: '100vh', background: 'transparent',
        fontFamily: "'Noto Sans KR',-apple-system,sans-serif", color: tc, position: 'relative',
      }}>
        <div style={{ position: 'relative', zIndex: 1, padding: '24px 28px 100px', maxWidth: 860, margin: '0 auto' }}>

          {/* ─────────────── 1단계: 업로드 ─────────────── */}
          {step === 'upload' && (
            <div style={{ animation: 'fadeInUp 0.5s both' }}>
              <Header
                title="📸 보관함 가져오기"
                desc="음악 앱 보관함/재생목록 스크린샷을 올리면 곡을 불러와 취향을 분석해드려요"
              />

              <div style={{ ...G(0.62), borderRadius: 22, padding: '26px 28px' }}>
                {/* 드롭/선택 영역 */}
                <div
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); handleFiles(e.dataTransfer.files) }}
                  style={{
                    border: `2px dashed ${isDark ? 'rgba(140,160,255,0.35)' : 'rgba(100,120,200,0.35)'}`,
                    borderRadius: 18, padding: '40px 20px', textAlign: 'center', cursor: 'pointer',
                    background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(100,120,200,0.04)',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{ fontSize: 40, marginBottom: 10 }}>🖼️</div>
                  <p style={{ fontSize: 15, fontWeight: 600, color: tc, marginBottom: 4 }}>
                    스크린샷을 끌어다 놓거나 클릭해서 선택
                  </p>
                  <p style={{ fontSize: 12, color: sc }}>최대 5장 · 곡 목록이 또렷하게 보일수록 정확해요</p>
                  <input
                    ref={fileRef} type="file" accept="image/*" multiple hidden
                    onChange={e => handleFiles(e.target.files)}
                  />
                </div>

                {/* 선택된 이미지 미리보기 */}
                {images.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 18 }}>
                    {images.map((img, i) => (
                      <div key={i} style={{ position: 'relative' }}>
                        <img src={img.url} alt="" style={{
                          width: 90, height: 120, objectFit: 'cover', borderRadius: 12, border,
                        }} />
                        <button onClick={() => removeImage(i)} style={{
                          position: 'absolute', top: -8, right: -8, width: 22, height: 22, borderRadius: '50%',
                          border: 'none', background: 'rgba(255,60,90,0.92)', color: '#fff',
                          cursor: 'pointer', fontSize: 12, lineHeight: 1,
                        }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {error && <p style={{ color: '#e0506a', fontSize: 13, marginTop: 16 }}>{error}</p>}

                <button
                  onClick={extractSongs}
                  disabled={images.length === 0 || busy}
                  style={{
                    width: '100%', marginTop: 20, padding: '15px', borderRadius: 14, border: 'none',
                    cursor: images.length === 0 || busy ? 'not-allowed' : 'pointer',
                    background: images.length > 0 && !busy
                      ? `linear-gradient(135deg,${theme.from},${theme.to})` : 'rgba(100,120,200,0.15)',
                    color: images.length > 0 && !busy ? '#fff' : sc,
                    fontSize: 15, fontWeight: 700, opacity: images.length > 0 && !busy ? 1 : 0.6,
                    boxShadow: images.length > 0 && !busy ? `0 6px 20px ${theme.to}44` : 'none',
                  }}
                >
                  {busy ? (progress || '분석 중…') : '🎵 곡 불러오기 →'}
                </button>

                <p style={{ fontSize: 11, color: sc, marginTop: 14, textAlign: 'center' }}>
                  🔒 이미지는 곡 인식에만 쓰이고 저장되지 않아요. 곡 제목/아티스트만 보관해요.
                </p>
              </div>
            </div>
          )}

          {/* ─────────────── 2단계: 추출 결과 확인/편집 ─────────────── */}
          {step === 'review' && (
            <div style={{ animation: 'fadeInUp 0.5s both' }}>
              <Header
                title="✅ 불러온 곡 확인"
                desc="잘못 읽힌 곡은 고치거나 지운 뒤 취향 분석을 시작하세요"
              />

              <div style={{ ...G(0.62), borderRadius: 22, padding: '22px 24px' }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 14 }}>
                  🎶 불러온 곡 <span style={{ color: sc, fontWeight: 400 }}>{songs.length}곡</span>
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {songs.map((s, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 6px',
                      borderRadius: 10, background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(100,120,200,0.05)',
                    }}>
                      <span style={{ fontSize: 11, color: sc, width: 22, textAlign: 'center', flexShrink: 0 }}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <input
                        value={s.title} onChange={e => editSong(i, 'title', e.target.value)}
                        placeholder="제목"
                        style={{
                          flex: 2, minWidth: 0, padding: '7px 10px', borderRadius: 8, border,
                          background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.6)',
                          color: tc, fontSize: 13, fontFamily: 'inherit',
                        }}
                      />
                      <input
                        value={s.artist} onChange={e => editSong(i, 'artist', e.target.value)}
                        placeholder="아티스트"
                        style={{
                          flex: 1.4, minWidth: 0, padding: '7px 10px', borderRadius: 8, border,
                          background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.6)',
                          color: sc, fontSize: 12, fontFamily: 'inherit',
                        }}
                      />
                      <button onClick={() => removeSong(i)} style={{
                        background: 'none', border: 'none', color: sc, cursor: 'pointer',
                        fontSize: 14, padding: 4, flexShrink: 0,
                      }}>✕</button>
                    </div>
                  ))}
                </div>

                {error && <p style={{ color: '#e0506a', fontSize: 13, marginTop: 14 }}>{error}</p>}

                <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
                  <button onClick={reset} disabled={busy} style={{
                    padding: '13px 20px', borderRadius: 12, border, background: 'transparent',
                    color: sc, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer',
                  }}>↩ 다시 올리기</button>
                  <button
                    onClick={analyzeTaste}
                    disabled={busy || songs.length === 0}
                    style={{
                      flex: 1, padding: '13px', borderRadius: 12, border: 'none',
                      cursor: busy ? 'not-allowed' : 'pointer',
                      background: `linear-gradient(135deg,#7C5CFF,#FF4D8D)`, color: '#fff',
                      fontSize: 14, fontWeight: 700, opacity: busy ? 0.7 : 1,
                      boxShadow: '0 6px 20px rgba(124,92,255,0.35)',
                    }}
                  >
                    {busy ? (progress || '분석 중…') : '✨ 보관함 저장 + 취향 분석 →'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ─────────────── 3단계: 취향 리포트 ─────────────── */}
          {step === 'result' && profile && (
            <div style={{ animation: 'fadeInUp 0.5s both' }}>
              <Header
                title="🎧 내 음악 취향"
                desc={`보관함 ${profile.songCount}곡을 분석한 결과예요`}
              />

              {/* 요약 카드 */}
              {profile.summary && (
                <div style={{
                  ...G(0.62), borderRadius: 22, padding: '24px 26px', marginBottom: 16,
                  borderLeft: `4px solid ${theme.text ? BAR_COLORS[0] : BAR_COLORS[0]}`,
                }}>
                  <p style={{ fontSize: 12, color: sc, marginBottom: 8, letterSpacing: 1 }}>AI 한줄 요약</p>
                  <p style={{ fontSize: 16, lineHeight: 1.7, color: tc, fontWeight: 500 }}>{profile.summary}</p>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>

                {/* 장르 분포 */}
                {profile.genres.length > 0 && (
                  <div style={{ ...G(0.62), borderRadius: 22, padding: '22px 24px' }}>
                    <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 16 }}>🎼 장르 분포</p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {profile.genres.map((g, i) => {
                        const pct = Math.max(2, Math.min(100, Number(g.percent) || 0))
                        const color = BAR_COLORS[i % BAR_COLORS.length]
                        return (
                          <div key={i}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                              <span style={{ fontSize: 13, color: tc, fontWeight: 500 }}>{g.name}</span>
                              <span style={{ fontSize: 12, color: sc }}>{pct}%</span>
                            </div>
                            <div style={{ height: 8, borderRadius: 6, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(100,120,200,0.12)', overflow: 'hidden' }}>
                              <div style={{
                                width: `${pct}%`, height: '100%', borderRadius: 6,
                                background: `linear-gradient(90deg,${color}bb,${color})`,
                                transition: 'width 0.7s cubic-bezier(0.4,0,0.2,1)',
                              }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 분위기 + 에너지 + 시대 */}
                <div style={{ ...G(0.62), borderRadius: 22, padding: '22px 24px' }}>
                  {profile.moods.length > 0 && (
                    <>
                      <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 12 }}>🌈 분위기</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                        {profile.moods.map((m, i) => (
                          <span key={i} style={{
                            padding: '7px 14px', borderRadius: 16, fontSize: 13, fontWeight: 500,
                            background: `${BAR_COLORS[(i + 2) % BAR_COLORS.length]}22`,
                            color: BAR_COLORS[(i + 2) % BAR_COLORS.length],
                            border: `1px solid ${BAR_COLORS[(i + 2) % BAR_COLORS.length]}44`,
                          }}>{m.name}</span>
                        ))}
                      </div>
                    </>
                  )}

                  <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 8 }}>
                    ⚡ 에너지 <span style={{ fontSize: 12, color: sc, fontWeight: 400 }}>
                      {profile.energy < 35 ? '잔잔한 편' : profile.energy > 65 ? '신나는 편' : '적당한 편'}
                    </span>
                  </p>
                  <div style={{ position: 'relative', height: 10, borderRadius: 6, marginBottom: 18,
                    background: 'linear-gradient(90deg,#4090e0,#9060d0,#FF4D8D)' }}>
                    <div style={{
                      position: 'absolute', top: -3, left: `calc(${profile.energy}% - 8px)`,
                      width: 16, height: 16, borderRadius: '50%', background: '#fff',
                      border: '3px solid #7C5CFF', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                    }} />
                  </div>

                  <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 6 }}>🕰️ 주로 듣는 시대</p>
                  <p style={{ fontSize: 15, color: BAR_COLORS[2], fontWeight: 600 }}>{profile.era}</p>
                </div>
              </div>

              {/* 대표 아티스트 */}
              {profile.topArtists.length > 0 && (
                <div style={{ ...G(0.62), borderRadius: 22, padding: '22px 24px', marginTop: 16 }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: tc, marginBottom: 14 }}>🎤 자주 듣는 아티스트</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {profile.topArtists.map((a, i) => (
                      <button key={i} onClick={() => onPlaySong?.({ title: a, artist: a, youtubeQuery: `${a} 인기곡` })}
                        style={{
                          padding: '10px 18px', borderRadius: 20, cursor: 'pointer',
                          border: `1px solid ${BAR_COLORS[i % BAR_COLORS.length]}55`,
                          background: `${BAR_COLORS[i % BAR_COLORS.length]}18`,
                          color: BAR_COLORS[i % BAR_COLORS.length], fontSize: 13, fontWeight: 600,
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                        <span style={{ fontSize: 14 }}>🎵</span>{a}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {error && <p style={{ color: '#e0506a', fontSize: 13, marginTop: 14 }}>{error}</p>}

              {/* 액션 */}
              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button onClick={reset} style={{
                  padding: '14px 22px', borderRadius: 14, border, background: 'transparent',
                  color: sc, fontSize: 14, cursor: 'pointer',
                }}>↩ 다시 분석</button>
                <button onClick={onBack} style={{
                  flex: 1, padding: '14px', borderRadius: 14, border: 'none', cursor: 'pointer',
                  background: `linear-gradient(135deg,${theme.from},${theme.to})`, color: '#fff',
                  fontSize: 14, fontWeight: 700, boxShadow: `0 6px 20px ${theme.to}44`,
                }}>완료 — 취향이 추천에 반영됐어요 ✓</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
