=== Wisp TWA — Google Play APK ===

APK: /opt/wisp-twa/wisp-1.0.apk (1.1 MB)
Keystore: /opt/wisp-twa/wisp-release.keystore
Alias: wisp
Hasło keystora i klucza: wisp2026release

SHA-256 fingerprint keystora:
F1:E6:31:67:CE:88:AE:8C:31:20:5B:E5:17:EF:45:AC:93:8C:C2:94:45:B6:FB:4E:CE:0F:08:0F:D9:E8:26:E7

Package ID: com.epro.wisp
Domain: wispplay.com
Start URL: /game.html
Min Android: 5.0 (API 21)
Target Android: 14 (API 34)

=== Digital Asset Links ===
URL: https://wispplay.com/.well-known/assetlinks.json
Status: AKTYWNY (serwowany przez Express)

=== Co trzeba zrobić dalej ===
1. Zarejestruj konto Google Play Console ($25 jednorazowo)
   URL: https://play.google.com/console/signup
   
2. Utwórz nową aplikację w Play Console
   - Wybierz: Aplikacja → Darmowa
   - Kraj: Polska (lub wszystkie)
   
3. Wypełnij wymagane formularze:
   - Opis aplikacji (PL + EN)
   - Screenshoty (min. 2, rozmiar 1080px+)
   - Ikona wysokiej rozdzielczości (512x512)
   - Grafika wyróżniająca (1024x500)
   
4. Wgraj APK do sekcji "Wersje" → "Testowanie wewnętrzne"
   Plik: /opt/wisp-twa/wisp-1.0.apk
   
5. Po weryfikacji przez Google: przejdź do produkcji

=== Ważne pliki ===
Android projekt: /opt/wisp-twa/android/
Aby zbudować nowy APK po zmianach:
  cd /opt/wisp-twa/android
  ./gradlew assembleRelease
  apksigner sign --ks /opt/wisp-twa/wisp-release.keystore \
    --ks-key-alias wisp --ks-pass pass:wisp2026release \
    --key-pass pass:wisp2026release \
    --out /opt/wisp-twa/wisp-1.0.apk \
    app/build/outputs/apk/release/app-release-unsigned.apk
