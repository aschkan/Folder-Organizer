<div align="center">

# 📁 Folder Organizer (Klasör Düzenleyici)

**En dağınık klasörlerinizi güvenle kategorilere ayıran yerel, gizli ve yapay zekâ destekli bir araç — uygulamalarınızı, kod projelerinizi veya veritabanlarınızı asla bozmadan — tek tıkla tam geri alma özelliğiyle.**

Her şey kendi makinenizde çalışır. Hiçbir şey yüklenmez. Siz gözden geçirip onaylayana kadar hiçbir dosya taşınmaz.

[English](README.md) ·
[فارسی](README.fa.md) ·
[العربية](README.ar.md) ·
[Español](README.es.md) ·
[中文](README.zh.md) ·
[हिन्दी](README.hi.md) ·
[Русский](README.ru.md) ·
[Français](README.fr.md) ·
[Deutsch](README.de.md) ·
[Português](README.pt.md) ·
[日本語](README.ja.md) ·
🌐 **Türkçe**

</div>

---

## ✨ Onu farklı kılan ne

Çoğu "dosya düzenleyici" her şeyi yalnızca uzantıya göre klasörlere dağıtır ve bunu yaparken yalnızca bir bütün olarak çalışan şeyleri **bozar**: bir kod projesi, taşınabilir bir uygulama, bir veritabanı, kaydedilmiş bir web sayfası. Bu uygulama yapıyı anlar:

- 🛡️ **Bütün birimleri sağlam tutar.** Kod projeleri (`package.json`, `.git`, …), uygulamalar ve programlar (taşınabilir uygulamalar, tarayıcılar, emülatörler, oyunlar — uzantısı olmayan Linux/macOS ikili dosyaları bile), veritabanları (SQLite, LevelDB/RocksDB) ve kaydedilmiş web sayfaları (`..._files` klasörleri) **tek parça** olarak taşınır, asla dağıtılmaz.
- 🤖 **Sabit bir liste değil, yapay zekâ odaklı.** Kategoriler koda gömülü değildir. İsteğe bağlı bir **yerel LLM**, bilinmeyen dosya türlerini tam yol bağlamıyla sınıflandırır ve yeni kategoriler oluşturabilir — ve her taramanın sonunda **tüm planı yeniden gözden geçirerek kendi hatalarını düzeltir**.
- ⏪ **Tamamen geri alınabilir.** Her çalıştırmanın anlık görüntüsü alınır; tek tıkla her şey tam olarak eski yerine döner.
- 💾 **Çökmeye dayanıklı.** Bilgisayarınız veya uygulama işlemin ortasında kapanırsa, yeniden başlatıldığında tam kaldığı yerden devam eder.
- 🔒 **%100 yerel ve gizli.** Bulut yok, telemetri yok, hesap yok.

---

## 🚀 Hızlı başlangıç

```bash
npm install
npm start
```

Ardından tarayıcınızda **http://localhost:4173** adresini açın.
(Bağlantı noktasını değiştirmek için: `PORT=5000 npm start`.)

---

## 🧩 Ne yapar

- 🗂️ **Akıllı kategorilendirme** — resimler, video, müzik, belgeler, kod, **modeller** (ML ağırlıkları), **veritabanları**, arşivler, **kısayollar**, **yapılandırma** ve daha fazlası — ayrıca sizin veya yapay zekânın oluşturduğu her kategori.
- 🛡️ **Sağlam tutar**: projeler, uygulamalar, veritabanları ve kaydedilmiş web sayfaları.
- 🤖 **Yerel LLM (isteğe bağlı)** — bilinmeyen türleri sınıflandırır ve **tüm dosyalar üzerinde son bir inceleme** yapar.
- 🔁 **Yinelenen tespiti** — tam eşleşenler (içerik özeti ile) ve görsel olarak benzer fotoğraflar.
- 🧹 **Temizlik** — `node_modules`, derleme önbellekleri ve işletim sistemi çöp dosyaları.
- 📸 **Akıllı alt klasörler** — fotoğraflar EXIF tarihine, müzik sanatçı/albüme göre.
- 👀 **Taşımadan önce inceleyin** — tüm planı görün, düzenleyin, istediğinizi hariç tutun.
- ⏪ **Geri alma + anlık görüntüler** her çalıştırmanın klasör yapısı için.
- 💾 **Kesintiden sonra otomatik devam.**
- 📊 **Canlı ilerleme ve gerçek zamanlı günlük.**

---

## 🔒 Gizlilik

Bu kişisel bir masaüstü aracıdır: giriş yok, çoklu kullanıcı yok, bulut yok, telemetri yok. Tüm durum (öğrenilen kategori kuralları, tarama anlık görüntüleri, geri alma için çalıştırma geçmişi) uygulamanın yanındaki yerel bir `data/` klasöründe bulunur. İsteğe bağlı LLM'yi etkinleştirirseniz, istekler yalnızca **sizin** yapılandırdığınız yerel uç noktaya gider.
