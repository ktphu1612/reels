# ReelForge Studio

ReelForge Studio là web app chạy cục bộ trên Windows để biến các ảnh card và script thành video dọc kiểu gameplay. Card có thể dùng TTS hoặc giữ hình không lời; mỗi card có thể có meme image + sound hoặc video meme, kèm intro, transition, nhạc nền và tốc độ đọc tùy chọn.

## Chạy nhanh

Cách đơn giản nhất trên Windows là double-click [ReelForge Studio.cmd](<ReelForge Studio.cmd>). Launcher kiểm tra Node 24, chạy setup, xác minh FFmpeg/ffprobe bundled, mở app sau khi health check tại loopback đã sẵn sàng.

Chạy bằng terminal:

```powershell
npm ci
npm run setup
npm run build
npm start
```

App chạy tại [http://127.0.0.1:3000](http://127.0.0.1:3000). Dùng `Ctrl+C` ở terminal để dừng an toàn.

## Tính năng và giới hạn

- Nhập template gameplay sạch và thumbnail tùy chọn.
- Ảnh card hoàn chỉnh dùng PNG/JPEG/WebP. Card có script dùng TTS; card trống giữ hình từ 1–5 giây (mặc định 3 giây).
- Chọn Google Cloud TTS hoặc ElevenLabs, voice, model và tốc độ đọc `0.5×–2.0×`.
- Tốc độ được xử lý cục bộ bằng FFmpeg sau khi nhận audio TTS, nên áp dụng cho mọi provider/model.
- Chọn meme image + meme sound hoặc video meme theo từng card. Video meme giữ audio gốc và có thể chồng thêm meme sound.
- Chọn Intro Sound và một Transition Sound riêng dùng chung cho cả project.
- Chọn nhạc nền; nhạc bắt đầu sau intro, lặp đến hết video và tự động giảm khi có narration hoặc effect.
- Preview card, meme image và meme video dùng cùng UI kéo-thả để đổi vị trí và bốn góc để resize theo đúng tỉ lệ media; có thể reset về vị trí vừa trong slot template.
- Gameplay bị tắt audio. Không có lớp hình cố định trên template.
- Queue SQLite bền vững, autosave project, batch render, cancel, retry và khôi phục job sau restart.
- Output là H.264/AAC, 720×1280, 30 fps, `yuv420p`, CRF 20 và `faststart`.

Tài nguyên được đọc trực tiếp từ năm thư mục cố định. Xem [Thư viện tài nguyên](docs/RESOURCE_LIBRARY.md).

## Yêu cầu

- Windows 10/11 64-bit.
- Node.js 24 trở lên và npm.
- Kết nối Internet khi gọi Google Cloud TTS hoặc ElevenLabs.
- Không cần cài FFmpeg riêng vào `PATH`; renderer dùng binary bundled trong dependency.
- Chrome hoặc Edge để xem preview.

Kiểm tra Node:

```powershell
node --version
npm --version
```

## Cài đặt và chạy development

Từ thư mục repository:

```powershell
npm ci
npm run setup
npm run build
npm run lint
npm test
```

### Đặt thư mục dữ liệu và API key

API và worker phải dùng cùng một `REELFORGE_HOME`. Nếu không đặt biến, mặc định là thư mục repository.

```powershell
$env:REELFORGE_HOME = 'D:\ReelForgeData'
New-Item -ItemType Directory -Force $env:REELFORGE_HOME | Out-Null
Copy-Item '.env.local.example' (Join-Path $env:REELFORGE_HOME '.env.local')
```

Mở `.env.local` và điền:

```text
GOOGLE_TTS_API_KEY=...
ELEVENLABS_API_KEY=...
```

Chỉ backend đọc các key này. Không đưa key vào project, log, frontend hoặc SQLite. Sau khi đổi key, restart API và worker.

### Chạy development

```powershell
npm run dev
```

Development dùng UI tại [http://127.0.0.1:5173](http://127.0.0.1:5173) và API tại `127.0.0.1:3000`.

Health check:

```powershell
Invoke-WebRequest 'http://127.0.0.1:3000/api/health' | Select-Object -ExpandProperty Content
```

Kết quả hợp lệ có `{"status":"ok"}`.

### Các script chính

| Lệnh | Công dụng |
| --- | --- |
| `npm ci` | Cài dependency theo `package-lock.json`. |
| `npm run setup` | Kiểm tra Node, thư mục dữ liệu, quyền ghi và FFmpeg/ffprobe. |
| `npm run build` | Build workspace và UI. |
| `npm run lint` | Type-check strict. |
| `npm test` | Chạy test workspace. |
| `npm run test:security` | Chạy security regression tests. |
| `npm run dev` | Chạy UI development, API và worker. |
| `npm start` | Chạy production supervisor, API, worker và UI. |

## Quy trình tạo video

1. Chuẩn bị template gameplay sạch theo [Hướng dẫn template](docs/CLEAN_TEMPLATE_GUIDE.md).
2. Đặt resource vào năm thư mục theo [Thư viện tài nguyên](docs/RESOURCE_LIBRARY.md), rồi restart app.
3. Tạo project, chọn template, provider, voice và tốc độ đọc.
4. Thêm ảnh card hoàn chỉnh, viết script hoặc để trống để giữ hình 1–5 giây (mặc định 3 giây); reorder nếu cần.
5. Chọn intro, transition sound và nhạc nền ở cấp project.
6. Với mỗi card, chọn một cặp meme image + sound, hoặc video meme; video có thể chồng thêm sound.
7. Dùng Preview TTS để nghe thử, lưu project rồi đưa vào hàng đợi.
8. Theo dõi Queue; job lỗi có thể retry và job đang chạy có thể cancel.

Thứ tự trong video là: card 1 và intro bắt đầu tại `t=0`; khi intro kết thúc, TTS card 1 và nhạc nền bắt đầu. Sau nội dung hoặc hold của card, meme (nếu có) phát; card tiếp theo xuất hiện đúng lúc transition bắt đầu, rồi narration/hold của card tiếp theo tiếp tục theo timeline. Card đầu không có transition; không có transition sau card cuối. Nhạc nền tự giảm dưới narration/effect.

## Bố cục mặc định

Ảnh card dùng `contain`, không crop. Các vị trí là normalized rectangle:

| Lớp | x | y | width | height | Trên canvas 720×1280 |
| --- | ---: | ---: | ---: | ---: | --- |
| Card | 5% | 38% | 90% | 25% | x=36, y=486, w=648, h=320 |
| Meme | 30% | 63% | 40% | 31% | x=216, y=806, w=288, h=397 |

Template chỉ chứa gameplay background, card slot và meme slot. Không có lớp hình cố định.

Trong Preview, kéo visual để đổi vị trí và kéo một trong bốn góc để resize theo đúng aspect ratio, không crop hoặc méo hình. Card, meme image và meme video đều lưu rectangle normalized riêng; chọn **Về bố cục template** để bỏ override và fit lại visual trong slot template.

## Dữ liệu runtime

Base directory là `REELFORGE_HOME`:

```text
<base>\
├─ .env.local                 # key plaintext, chỉ backend đọc
├─ data\
│  ├─ assets\                # media managed theo SHA-256
│  ├─ projects\              # project JSON
│  ├─ templates\             # template JSON
│  ├─ cache\tts\             # audio TTS có thể tái tạo
│  ├─ jobs\                  # workspace và log của job
│  └─ queue.sqlite            # queue, event và settings
└─ outputs\                  # MP4 đã xuất
```

Output mặc định nằm trong `<base>\outputs` và không ghi đè file cũ. Khi sao lưu SQLite WAL, hãy dừng app trước và copy cả `queue.sqlite`, `queue.sqlite-wal`, `queue.sqlite-shm` nếu có.

## An toàn và quyền riêng tư

- API chỉ bind `127.0.0.1`; không dùng `0.0.0.0` hoặc port-forward ra mạng.
- API key chỉ nằm trong `.env.local` và không xuất hiện trong project, queue, cache key, frontend hay log.
- Resource source path không được ghi vào project hoặc response.
- Chỉ dùng gameplay, card, audio, image và voice mà bạn có quyền sử dụng.

## Tài liệu liên quan

- [Thư viện tài nguyên](docs/RESOURCE_LIBRARY.md)
- [Hướng dẫn tạo template sạch](docs/CLEAN_TEMPLATE_GUIDE.md)
- [Xử lý sự cố](docs/TROUBLESHOOTING.md)
- [Sao lưu và vòng đời dữ liệu](docs/DATA_AND_BACKUP.md)
