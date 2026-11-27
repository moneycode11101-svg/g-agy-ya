# Token Band

Antigravity App과 Antigravity CLI(`agy`) 모두에서 **누적 컨텍스트 · 캐시 읽기/쓰기 · 도구별 `+토큰` 증분 · 쿼타/사용량**을 실시간으로 추적하는 플러그인입니다.

## 구성 요소

1. **App 인라인 1줄 HUD (`hooks.json`)**
   - `PostInvocation` 훅이 `metadata.user_markdown`으로 1줄 HUD를 채팅창에 표시합니다.
   - `systemMessage` 본문은 비어 있어 모델 컨텍스트에 **0 토큰**만 차지합니다.
2. **App 사이드 패널 & 사이드바 대시보드 (MCP App)**
   - 우측 보조 패널(`+` 메뉴 → **Token Band**) 및 좌측 사이드바(**Token Band**)에서 실시간 게이지, 도구별 `+토큰` 랭킹, 호출 로그, 스텝 추이 그래프, HUD 설정을 확인할 수 있습니다.
3. **CLI 하단 `statusLine` (`cli/statusline.sh`)**
   - `~/.gemini/antigravity-cli/settings.json`에 연동되어 `agy` CLI 하단에 실시간 컨텍스트 바, `Cache R/W`, 최근 도구 `+토큰`, 공식 **계정 쿼타 % 및 리셋 시간**을 표시합니다.
   - CLI가 실행될 때 공식 쿼타 스냅샷을 `~/.gemini/antigravity/token-band/live-quota.json`에 자동 동기화하여 Antigravity App에서도 함께 확인할 수 있습니다.
