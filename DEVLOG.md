# Forest Cards · Dev Log

Plik historii zmian projektu. Aktualizowany po każdej sesji roboczej.
Repo: https://github.com/twitusik-epro/wisp-forest-cards

---

## 2026-04-20 — TWA v1.6 (versionCode 7)
- Nowy splash screen (wygenerowany Gemini)
- Nowe `ic_launcher` — duszek + karta
- Zbudowany AAB, wgrany do Google Play

## 2026-04-13 — TWA v1.5 (versionCode 6)
- Pierwsze wydanie na Google Play
- pkg: `com.epro.forestcards`

## 2026-04-01 — i18n i ranking
- i18n: `FC_LANGS/FCLANG/applyFCLang()`, 5 języków (PL/EN/DE/ES/FR)
- Ranking Top 20 + 20 seed graczy
- Waluta: grzyby 🍄 (Paddle billing)

## 2026-03-xx — Pierwsze wdrożenie
- Gra karciana Forest Cards na cards.wispplay.com, port 3002, PM2 process `forest-cards`
- Admin panel: wispplay.com/admin (proxy `/api/fc-admin/*` → :3002)
- Strategiczna gra karciana osadzona w świecie Wispa
