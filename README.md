# BOX TERMINAL

포켓몬고 박스 정리 도우미 (친구용 비공식 팬 도구)

- `site/` — 사이트 본체. Cloudflare Pages가 이 폴더를 그대로 배포
- `site/data/events.json` — 홈 화면 일정 (매일 자동 갱신)
- `scripts/update-events.mjs` — LeekDuck(ScrapedDuck) 일정 수집 + Gemini 한국어 번역
- `.github/workflows/update-events.yml` — 매일 04:17(KST) 자동 실행

## 설정
1. 저장소 Settings → Secrets and variables → Actions → `GEMINI_API_KEY` 추가 (선택. 없으면 영어 원문으로 저장)
2. Cloudflare Pages → Git 저장소 연결 → 빌드 명령 비움, 출력 디렉터리 `site`
3. Actions 탭 → "이벤트 일정 갱신" → Run workflow 로 첫 실행
