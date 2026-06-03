# Rezidentura Project — Admin Edit versiyası

Bu versiyada hər sualın "flag" hissəsinin yanında **"Dəyiş" (edit)** düyməsi əlavə olunub.

- Düyməni klikləyəndə admin şifrəsi soruşulur (`rezident2025`).
- Şifrə doğru olduqda sualın mətni və düzgün cavab məlumatı `prompt` pəncərələri ilə dəyişdirilə bilər.
- Dəyişikliklər brauzerdə `localStorage`-da `editedQuestions` açarı altında JSON kimi saxlanılır.
- Səhifə yenilənsə belə, eyni brauzerdə bu dəyişikliklər qalır.

Layihə strukturu:

```
rezidentura_project_edit/
  index.html
  assets/
    css/
      style.css
    js/
      firebase-init.js   (əgər mövcuddursa)
      app.js             (əsas məntiq və admin edit funksiyası)
    images/              (hazırda boş)
```

Saytı işlətmək üçün lokal serverdən (məs: `python -m http.server 8000`) istifadə etməyin vacibdir ki, JSON fayllarına `fetch` normal işləsin.


Bu paket: mövcud saytın üzərinə Firestore oxuma (fb-bridge.js) + ayrıca add.html əlavə edir.