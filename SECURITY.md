# 🔐 SECURITY

이 프로젝트는 Firebase, Gemini, YouTube Data API 등 외부 API 키를 사용합니다.

## API 키 관리 원칙

- 실제 키 값은 `.env` 파일에만 저장하고, `.env`는 절대 git에 커밋하지 않습니다 (`.gitignore`에 등록되어 있습니다).
- 키 템플릿은 `.env.example`에만 placeholder로 남깁니다.
- `VITE_` 접두사가 붙은 환경변수는 Vite 빌드 시 브라우저 번들에 그대로 포함됩니다. 즉, 클라이언트에 노출되는 키이므로 다음 조치가 필요합니다.
  - Google Cloud Console / Firebase Console에서 키별로 **HTTP Referrer 제한**, **API 제한**(허용된 API만 호출 가능하도록)을 설정하세요.
  - 가능하면 민감한 호출(Gemini 등)은 백엔드 프록시를 거치도록 구조를 변경하는 것을 권장합니다 (`src/md/21_HANDOFF_BACKEND.md` 참고).

## 만약 키가 실수로 커밋/유출되었다면

1. 해당 발급처 콘솔에서 즉시 키를 폐기(revoke)하고 새 키를 발급합니다.
2. git 히스토리에 남아있다면 `git filter-repo` 등으로 히스토리에서 제거합니다 (단순 삭제 커밋만으로는 과거 커밋에 키가 그대로 남습니다).
3. `.env.example`에는 실제 값이 아닌 placeholder만 남겨둡니다.

## 이 저장소에서 확인한 사항

- `.env`는 git 추적에서 제외되어 있습니다.
- 문서(`src/md/`) 내 예시에 실제 키 값이 하드코딩되어 있던 부분은 발견 시 placeholder로 치환했습니다.
