# MyAI — AI Chat Pribadimu (mirip ChatGPT / Claude / Gemini)

Website chat AI pribadi dengan frontend statis, Firebase Authentication/Firestore, dan backend AI Cloudflare Workers. AI guest gratis tidak memerlukan login atau key dari pengguna; model akun dan sinkronisasi tetap memerlukan Google.

Model yang didukung:

| Sumber | Model | Biaya |
|---|---|---|
| **Google Gemini** | Gemini dari katalog akun atau Worker | Kuota dan biaya mengikuti konfigurasi akun/provider |
| **Groq** | Model dari katalog akun atau Worker | Kuota dan biaya mengikuti konfigurasi akun/provider |
| **OpenRouter** | Model dari katalog akun atau Worker | Model gratis tersedia di Worker; key pribadi dapat mengakses model berbayar |

Tidak ada bobot model AI yang diunduh ke browser. Setiap jawaban tetap memerlukan koneksi internet ke Worker atau API provider. Worker membatasi model gratis; key pribadi memanggil provider langsung dan dapat menggunakan model berbayar.

Daftar model berasal dari katalog provider yang berhasil dimuat. Worker membatasi model ke allowlist gratis; key akun langsung mengikuti akses provider. Jika key tidak valid atau katalog tak terjangkau, grup provider tidak menampilkan model cadangan yang usang.

## Pembaruan keamanan dan stabilitas di v3.6

- Website dan jalur `/api` tersedia di Cloudflare Pages; gateway Pages meneruskan permintaan ke Worker tanpa mengekspos key provider.
- Katalog OpenRouter Worker memuat model teks gratis terkini dan backend menolak chat yang tidak sesuai allowlist.
- Key yang tidak didukung tidak dipakai; nama provider tersebut ditampilkan sebagai peringatan, sementara provider yang didukung tetap bisa digunakan.
- Mode Umum, Coding, Flash, Pro, dan Max memilih model rekomendasi berbeda jika katalog menyediakan pilihan yang sesuai. Pilihan manual tetap disimpan per mode.
- API provider terkelola tetap dipanggil melalui Cloudflare Worker; opsi key pribadi dapat memanggil Gemini, Groq, dan OpenRouter langsung dari browser.
- Tidak ada lagi model WebGPU yang mengunduh bobot besar; localhost memakai gateway API Cloudflare Pages dan produksi memakai route same-origin.
- Login Google diperlukan untuk provider Worker dan key pribadi per akun.
- AI guest tersedia tanpa login jika secret provider dan binding rate limit sudah disiapkan di Worker.
- Login otomatis beralih ke redirect jika browser memblokir popup Google.
- Pemuatan katalog Worker memiliki batas waktu dan menjelaskan gangguan koneksi/DNS tanpa membuat tombol model terus menunggu.
- Backend memverifikasi token Firebase, email terverifikasi, dan akun Google sebelum menerima permintaan.
- Worker hanya mengizinkan model gratis. Key akun tidak terikat batas Worker dan dapat menimbulkan biaya langsung dari provider.
- API key lama dari `localStorage` dibersihkan otomatis saat membuka versi ini.

## Pemilih model di v3.7

- Model dikelompokkan berdasarkan tier **Gratis** atau **Premium / cek tarif**, lalu berdasarkan brand model seperti NVIDIA, Google, Qwen, dan lainnya.
- Model gratis Worker Gemini/Groq hanya muncul jika secret provider tersedia di server. Pengguna tidak memasukkan API key sendiri, tetapi tetap perlu login Google dan koneksi internet; admin perlu deploy Worker terbaru.
- Harga OpenRouter berasal dari katalog; key Gemini/Groq pribadi ditandai **Premium / cek tarif** kecuali modelnya ada di allowlist gratis Worker.
- Model Premium meminta konfirmasi setiap kali dikirim atau dijawab ulang. Model Premium tidak dipilih otomatis.
- Tidak ada AI offline tanpa unduhan: model AI tetap harus dijalankan oleh provider/server.

## SEO dan failover di v3.8

- Halaman menambahkan metadata description, canonical URL, Open Graph, Twitter card, dan structured data `SoftwareApplication`.
- Dialog dibuat lebih ringkas dengan batas tinggi dan scroll internal untuk layar kecil.
- Jika provider mengembalikan error kuota, key kedaluwarsa, atau stream kosong, aplikasi mencoba hingga tiga model Gratis lain dari brand/provider berbeda. Model Premium tidak pernah dipakai sebagai fallback otomatis.
- Model Gratis cadangan yang berhasil akan menjadi pilihan aktif berikutnya. Jika semua cadangan gagal, aplikasi menampilkan ringkasan error dan tidak mengirim ke model Premium.

## AI Gratis tanpa login di v4.0

- Tombol **Coba AI Gratis** memakai key Gemini/Groq milik server; pengguna tidak memasukkan key dan tidak mengunduh bobot model.
- Admin harus menyiapkan secret Gemini atau Groq dan deploy `worker/wrangler.toml` terbaru, termasuk rate limit guest 5 request per 60 detik. Tanpa konfigurasi itu, opsi guest tidak tersedia.
- Guest dibatasi 6.000 karakter dan 512 token jawaban. Fitur gambar menerima satu PNG/JPG/WebP per chat dan memerlukan secret Gemini.
- Bila Gemini guest terkena kuota atau gagal, Worker mencoba Groq gratis; jika keduanya gagal, aplikasi menampilkan error. Semua penggunaan tetap memerlukan internet.
- Gambar guest diproses di browser menjadi JPEG kecil, hanya berada di memori tab, dan tidak disimpan pada draft `localStorage`.
- Kuota OpenRouter free berlaku pada satu key server bersama. Dokumentasi OpenRouter mencatat batas default 20 request/menit dan 50/hari jika akun belum pernah membeli kredit; ambang dan batas dapat berubah, jadi pengguna guest berbagi kuota itu.

## Fallback OpenRouter guest di v4.1

- Jika Gemini dan Groq guest gagal, Worker mencoba model OpenRouter hanya setelah katalog memverifikasi harga nol.
- Batas OpenRouter free berlaku pada key server bersama seluruh pengguna, bukan kredit harian terpisah per akun. Batas default yang didokumentasikan OpenRouter saat akun belum membeli kredit adalah 20 request/menit dan 50/hari; angka dan kelayakan dapat berubah.
- Cerebras Free Trial adalah kredit $5 satu kali yang kedaluwarsa setelah 30 hari, bukan kredit harian berulang. GitHub Copilot Free adalah kuota dalam layanan Copilot, bukan endpoint API umum untuk dipasang sebagai provider di MyAI.

## Buat gambar, PPT, Word, Excel otomatis di v5.1

- Cukup tulis permintaan biasa, mis. "buatkan gambar kucing astronot", "buat PPT tentang pemanasan global 8 slide", "buatkan surat lamaran dalam format Word", atau "bikin Excel daftar gaji karyawan". MyAI mendeteksi jenis permintaan dan mengarahkannya ke AI yang mampu tanpa perlu ganti mode.
- **Gambar** dialihkan otomatis ke Pollinations (Flux, cadangan Turbo, lalu Gemini Image jika ada key Gemini di akun) walau model chat yang dipilih tidak bisa membuat gambar.
- **PowerPoint / Word / Excel / PDF**: model teks aktif diberi instruksi format khusus, lalu file `.pptx`, `.docx`, `.xlsx`, atau `.pdf` dibuat dan diunduh otomatis. Kartu **Unduh** tetap ada di bawah jawaban dan di riwayat chat. Excel memisahkan tiap tabel ke lembar sendiri, mengubah angka (termasuk format `1.000.000` / `Rp`) menjadi angka asli, dan memasang filter kolom.
- Jika belum ada model aktif atau semua model Gratis gagal, MyAI otomatis memakai **Pollinations AI** (gratis, tanpa key). Prompt pada cadangan ini dikirim ke layanan publik, jadi hindari data pribadi.
- Deteksi tidak aktif di mode Coding, dan tidak terpicu untuk pertanyaan seperti "cara membuat PPT", "kode Python untuk membaca Excel", atau "ringkas PDF ini".
- Tombol cepat **Buat gambar / Buat PPT / Buat Word / Buat Excel** tersedia di layar sambutan.

## Yang baru di v5.0

- **Kirim file lebih lengkap**: seret & lepas file/folder ke jendela, tempel gambar langsung (Ctrl/⌘+V), pilih banyak gambar sekaligus, chip lampiran dengan thumbnail & ukuran, deteksi duplikat, dan pesan error yang jelas.
- **Format baru**: Excel `.xls/.xlsx/.ods` (per lembar), OpenDocument `.odt/.odp`, `.rtf`, ZIP berisi daftar isi + file di dalamnya. PDF dibaca hingga 60 halaman dengan baris tetap utuh; PDF hasil scan otomatis dikirim sebagai gambar ke model vision. Batas 20 MB untuk dokumen/gambar, 8 MB untuk teks.
- **Mode tamu**: boleh melampirkan file teks/dokumen + 1 gambar per chat; percakapan panjang dipangkas otomatis agar tidak ditolak server.
- **Gambar AI gratis** di mode **Gambar** lewat Pollinations.ai (tanpa API key), lengkap dengan tombol unduh.
- **Pesan**: edit & kirim ulang pertanyaan, salin pesan, bacakan jawaban (🔊), rumus matematika (KaTeX), pratinjau HTML/SVG langsung dari blok kode, label bahasa pada kode, tautan terbuka di tab baru.
- **Konteks pintar**: tanggal/waktu dan profil "Tentang kamu" dikirim ke AI, riwayat dipangkas sesuai kapasitas model, gambar lama tidak dikirim ke model teks, dan otomatis beralih ke model vision bila ada gambar.
- **Riwayat chat**: dikelompokkan per tanggal, cari juga isi pesan, ganti nama (klik ✎ atau klik ganda), salin/unduh percakapan (.md) dari bilah atas.
- **Pengaturan** (⚙ di menu kiri): profil, gaya jawaban, kreativitas, Enter untuk kirim, baca otomatis, unduh/hapus semua chat.
- **Input suara** 🎙 (Chrome/Edge/Safari), tombol gulir ke bawah, dan pintasan: Ctrl/⌘+Shift+O chat baru, Ctrl/⌘+K cari, Esc hentikan jawaban.
- Build di macOS/Linux: `bash pages/build.sh` (Windows tetap memakai `pages/build.ps1`). Worker tidak berubah, jadi cukup deploy ulang Pages.

## Ekspor dokumen di v4.2

- Setelah AI menjawab, tekan **Ekspor** di bawah balasan untuk mengunduh Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), atau PDF.
- Untuk PowerPoint yang rapi, minta AI membuat judul dan isi per slide. Untuk Excel, minta tabel dengan nama kolom dan nilai yang jelas. Ekspor menyertakan judul, daftar, tabel, dan sumber yang tersedia.
- File dibuat di browser. Koneksi internet diperlukan saat format pertama kali dipakai untuk memuat pustaka ekspor dari CDN.
- Ekspor mengubah jawaban yang ada; ia tidak membuat konten baru dan tidak menambahkan gambar AI ke slide.

Percakapan bisa dikelompokkan ke folder kerja di menu kiri. Tekan tombol **＋** di samping Folder kerja untuk membuat folder, lalu tekan ikon folder di baris chat untuk memindahkannya atau mengembalikannya ke **Obrolan biasa**. Folder tersimpan di browser; penempatan chat juga ikut tersimpan bersama chat dan dapat tersinkronkan jika Firebase aktif.

Percakapan dapat dikelompokkan ke folder kerja dari menu kiri. Buat folder melalui tombol **＋** di bagian Folder kerja, lalu gunakan ikon folder pada percakapan untuk memindahkan atau mengembalikannya ke **Obrolan biasa**. Nama folder disimpan di browser; penempatan folder pada percakapan ikut tersimpan bersama chat.

## Tampilan dan keamanan

- Login Google Firebase diperlukan untuk provider AI server dan digunakan untuk menyinkronkan riwayat chat.
- Tombol tema gelap/terang; pilihan tema disimpan di browser.
- Secret Worker tidak dikirim ke frontend. Key pribadi yang disimpan di Firestore dibatasi ke UID akun, tetapi dipakai langsung dari browser dan dapat digunakan siapa pun yang mengakses sesi akun.

## Yang baru di v2.1

- **Logo & nama rapi tiap model**: Claude, GPT, Gemini, Qwen, DeepSeek, Llama, Mistral, Grok, Kimi, dll tampil dengan logonya (ikon dari [LobeHub Icons](https://github.com/lobehub/lobe-icons)).
- **Hanya versi terbaru**: versi lama otomatis disembunyikan (misal hanya Claude 5.5, bukan 3/4), tapi semua ukuran dari versi terbaru tetap ada (misal Qwen3.5 0.8B sampai 9B di mode lokal).
- **Pemilih model baru** dengan kotak pencarian dan pengelompokan per layanan.
- **Logo My AI** dari gambar `assets/myai-logo.png` di halaman pembuka/login; ikon ringkas digunakan pada area chat.
- **Composer satu kartu** dengan pemilih mode/model, lampiran file-folder, serta draft terpisah per mode agar tidak hilang saat berpindah mode.
- `kotak-prompt-myai.html` disertakan sebagai contoh prompt-box mandiri; `myai-repair-patch.md` berisi catatan perbaikan.

---

## Yang baru di v3.0

- **Tampilan ala Kimi**: sapaan dan kotak prompt terpusat saat chat kosong, chip saran di bawah prompt, sidebar abu muda, gelembung pengguna lembut, toast pil di atas, dan tema gelap yang selaras.
- **Mode AI terpisah** untuk Umum, Coding, dan Gambar. Mengirim saat file masih dibaca akan mengantre dan terkirim otomatis.
- Beranda kini tanpa contoh pertanyaan dan kartu petunjuk; composer ditempatkan lebih rendah agar layar chat lebih rapi.
- **Chip lampiran ringkas**: nama file tampil sebagai kartu kecil berikon di gelembung pengguna; isi file tetap dikirim ke model tetapi tidak ditampilkan di layar.
- Menu **+** ringkas untuk menambah file atau folder. Klik chip lampiran untuk membuka pratinjau.
- **Animasi loading AI**: teks shimmer dengan ikon bintang berputar.
- **Jawab ulang** pada balasan terakhir, tombol kirim dengan status warna (abu/hitam/merah), menu model yang terbuka otomatis pada model aktif, dan menu lampiran yang tertutup dengan Escape.

## Perbaikan sebelumnya di v2.2

- Isi file/folder tidak lagi ditampilkan sebagai teks panjang di balon chat; yang terlihat hanya pertanyaan dan ringkasan jumlah lampiran. Isi tetap dikirim ke model saat menganalisis file.
- Indikator animasi muncul saat file/folder dibaca dan saat AI sedang menyiapkan jawaban.
- Folder besar tetap ringkas di composer, dan proses unggah memberi ringkasan file yang berhasil dibaca/dilewati.
- Folder dependensi dan file berpotensi rahasia seperti `.env` atau private key dilewati otomatis. Konteks lampiran dibatasi agar permintaan tidak membengkak.
- Jawaban AI memiliki tombol **Salin jawaban**.
- Isi file tidak disimpan di riwayat permanen; isi lampiran tersedia untuk pertanyaan lanjutan hanya selama tab yang sama masih terbuka.

## Penjelasan singkat (tanpa background AI)

- **Transformer** adalah arsitektur di balik semua AI modern (GPT, Claude, Gemini, Qwen, DeepSeek). Intinya: model membaca teks, menghitung "perhatian" (*attention*) antar kata, lalu menebak kata berikutnya, berulang-ulang.
- **Melatih model sendiri dari nol** butuh ribuan GPU dan biaya miliaran rupiah. Karena itu kita memakai **model hasil riset yang sudah ada** (Qwen dari Alibaba, DeepSeek, Llama dari Meta, Gemma/Gemini dari Google). Semua "pengetahuan" dan data riset sudah tertanam di dalam model-model itu.
- Aplikasi mengirim permintaan provider melalui Cloudflare Worker setelah memverifikasi login Google. Model dan kuota gratis bergantung pada provider serta akun yang memiliki key.
- Model tidak dijalankan secara lokal; aplikasi tidak mengunduh bobot model.

---

## Menggunakan AI

1. Masuk menggunakan Google.
2. Untuk API gratis yang dikelola Worker, akun harus terdaftar dalam secret `AUTHORIZED_EMAILS`.
3. Untuk key pribadi, buka menu **＋ → Status provider AI**, simpan key provider, lalu pilih model dari grup **key akun**.
4. Semua jawaban memerlukan internet. Kuota/biaya provider mengikuti jenis key dan model yang dipilih.

Model pada grup **Gratis** tetap menggunakan kuota provider yang disediakan server; ketersediaannya bergantung pada konfigurasi admin. Grup **Premium / cek tarif** perlu dipilih dengan sengaja dan akan meminta konfirmasi sebelum permintaan dikirim.

### API key pribadi per akun

1. Masuk dengan Google, buka menu **＋ → Status provider AI**, lalu pilih Gemini, Groq, atau OpenRouter.
2. Tempel API key dan pilih **Simpan ke akun**. Key disimpan di `users/{uid}/private/settings`, tidak di `localStorage`, dan akan dimuat kembali saat akun Google yang sama login.
3. Pilih model dari grup provider bertanda **key akun**. Hapus key dari dialog yang sama untuk mencabut akses aplikasi.

Key akun dipakai langsung dari browser; ia tidak memperoleh pembatasan gratis/allowlist Worker dan provider dapat mengenakan biaya. Batasi key berdasarkan domain dan kuota pada dashboard provider. Untuk website yang digunakan banyak orang, simpan key sebagai secret Worker agar key tidak berada pada sesi browser.

## Setup Cloudflare Worker dan Pages gratis

Firebase Authentication dan Firestore tetap digunakan. Worker menyimpan secret provider; Pages menyajikan website serta gateway `/api` pada hostname `pages.dev`. Gateway ini diperlukan karena sebagian jaringan tidak dapat menjangkau hostname `workers.dev` secara langsung. Paket, batas, dan kuota provider dapat berubah; periksa [harga dan batas Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/) serta kuota provider sebelum deploy.

1. Pastikan Firebase Google Sign-In aktif. Setelah Pages dideploy, tambahkan hostname `myai-v3-firmansyah.pages.dev` ke **Firebase Console → Authentication → Settings → Authorized domains**. Untuk tes lokal gunakan `localhost`, bukan `127.0.0.1`. Firebase project saat ini `my-ai-69027`.
2. Secret `AI_PROVIDER_KEYS` dan `AUTHORIZED_EMAILS` tetap berada di Worker lama. Nilai secret tidak bisa dibaca atau dipindahkan otomatis, tetapi gateway Pages tidak memerlukan salinan secret.
3. Untuk membangun dan mengunggah website ke Pages, dari folder proyek jalankan:

   Di macOS/Linux cukup jalankan `bash pages/build.sh`, lalu `cd pages` dan perintah `npx wrangler` yang sama.

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\pages\build.ps1
   cd .\pages
   npx wrangler@latest pages project create myai-v3-firmansyah --production-branch main
   npx wrangler@latest pages deploy .\dist --project-name myai-v3-firmansyah
   ```

   Perintah `pages project create` hanya diperlukan sekali. Jika Wrangler menyatakan project sudah ada, lanjutkan ke deploy. `pages\_worker.js` hanya meneruskan `/api/models` dan `/api/chat` ke Worker yang sudah ada; file build tidak memuat folder `functions/` atau file `.env`.
4. Setelah deploy, gunakan URL `https://myai-v3-firmansyah.pages.dev`. Frontend sudah memakai URL API relatif `/api`. Situs GitHub Pages lama tidak berubah; gunakan URL Pages yang baru untuk login dan chat.
5. Jika menyiapkan Worker dari awal, tambahkan email Google yang boleh memakai API. Saat CLI meminta nilai secret, masukkan alamat email yang diizinkan; untuk beberapa alamat pisahkan dengan koma:

   ```powershell
   cd ..\worker
   npx wrangler@latest login
   npx wrangler@latest deploy
   npx wrangler@latest secret put AUTHORIZED_EMAILS
   ```

6. Simpan key provider yang punya paket gratis sebagai JSON secret Worker:

   ```powershell
   npx wrangler@latest secret put AI_PROVIDER_KEYS
   ```

   Contoh format: `{"openrouter":"KEY_OPENROUTER","gemini":"KEY_GEMINI","groq":"KEY_GROQ"}`. Ganti nilai contoh dengan key milikmu. Provider lain yang tidak terdaftar hanya diabaikan dan dilaporkan di menu status. Jangan kirim key melalui chat, jangan taruh di file frontend, dan jangan unggah file `.dev.vars`.

   Untuk menambah atau mengganti satu key tanpa menimpa JSON tersebut, simpan sebagai secret terpisah, misalnya `npx wrangler@latest secret put OPENROUTER_API_KEY`. Nama yang didukung: `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, dan `GROQ_API_KEY`. Secret terpisah akan diprioritaskan untuk provider yang sama.

Jika memakai sinkronisasi chat, aktifkan **Firestore Database** dan publikasikan aturan dari `firestore.rules`. Firebase Functions tidak diperlukan untuk API AI; `firebase.json` hanya menargetkan aturan Firestore agar Functions lama tidak ikut ter-deploy.

Menu **Status provider AI** menampilkan provider yang tersedia setelah login. Untuk mengganti satu key, jalankan `npx wrangler@latest secret put OPENROUTER_API_KEY` (atau nama secret provider lain di atas) dari folder `worker`. Untuk memperbarui semua key sekaligus, jalankan `npx wrangler@latest secret put AI_PROVIDER_KEYS`. Wrangler menerbitkan versi Worker yang memakai secret baru.

### Pemecahan masalah login dan model

- Jika login menunjukkan `unauthorized-domain`, tambahkan `firmansyahazharikuy6-spec.github.io` (tanpa `https://` atau `/My-AI`) di **Firebase Console → Authentication → Settings → Authorized domains**. Pastikan provider Google aktif. Popup yang diblokir akan dicoba kembali melalui redirect; error jaringan memerlukan koneksi yang bisa menjangkau layanan Google/Firebase.
- Jika katalog menunjukkan timeout dari website Pages, periksa status gateway Pages dan Worker yang menjadi tujuan; mengganti API key tidak memperbaiki gangguan koneksi.
- Jika login menunjukkan `unauthorized-domain`, tambahkan hostname Pages yang benar (tanpa `https://` atau `/`) di **Firebase Console → Authentication → Settings → Authorized domains**.
- OpenRouter hanya mengizinkan chat untuk model yang pada katalog terbarunya memiliki ID `:free`, input/output teks, dan semua harga nol. Model di luar syarat ini akan ditolak meskipun masih tampak di daftar awal saat katalog sedang tidak dapat diakses.

> `firebaseConfig` di frontend berisi konfigurasi publik Firebase; ia bukan tempat menyimpan provider API key. Jangan pernah menaruh provider key di `js/config.js`, file HTML/JS, atau variabel yang ikut dikirim ke browser. Paket gratis provider tidak menjamin akun tetap gratis jika billing diaktifkan atau kebijakan provider berubah.

---

## Struktur file

```
index.html        Tampilan utama
assets/myai-logo.png  Logo penuh My AI untuk halaman pembuka/login
assets/logo.svg       Ikon kecil / favicon
css/style.css     Desain (tema gelap)
js/config.js      Nama app, versi, URL Worker + konfigurasi Firebase
js/app.js         Logika UI chat & pemilih model
js/models.js      Logo model, nama rapi, filter "hanya versi terbaru"
js/providers.js   Katalog model dan koneksi ke Cloudflare Worker/provider
js/db.js          Login Google dan riwayat chat (Firebase / localStorage)
pages/            Gateway API same-origin dan build statis Cloudflare Pages
firestore.rules   Aturan keamanan database Firestore
worker/           Backend AI gratis (Cloudflare Worker + Wrangler)
firebase.json     Konfigurasi aturan Firestore; tidak men-deploy Functions
.firebaserc       Alias proyek Firebase untuk CLI
```

## Tips

- **Ganti nama AI-mu**: ubah `APP_NAME` di `js/config.js`; ganti logo penuh di `assets/myai-logo.png` dan ikon kecil di `assets/logo.svg`.
- Mode **Coding** memfilter model coding jika tersedia. Generasi gambar dan pencarian web dinonaktifkan pada konfigurasi gratis ini.
- Menu **+** menyediakan tambah banyak file sekaligus atau seluruh folder. Klik chip file sebelum/ sesudah dikirim untuk melihat pratinjau selama tab masih terbuka.
- Lampiran teks/kode, PDF, DOCX, XLSX, PPTX, ZIP, serta gambar umum dapat dibaca; file gambar dikirim sebagai input visual ke model vision yang mendukungnya.
- **Keamanan**: gunakan secret Cloudflare Worker untuk website bersama. Key akun pribadi disimpan di Firestore privat, tetapi browser dan sesi Google pemilik akun tetap dapat menggunakannya. Jangan taruh key di source code, repository, atau chat.
- Model/provider yang menyediakan kuota gratis dapat mengubah model, kuota, harga, dan kebijakannya kapan saja.

## Rotasi API key

Jika API key provider terekspos, cabut key lama di dashboard provider, lalu simpan key pengganti sebagai secret individual (misalnya `npx wrangler@latest secret put OPENROUTER_API_KEY`) dari folder `worker`. Jangan pernah mengirim key ke chat atau menyimpannya di frontend.
