# Thư viện tài nguyên

ReelForge tự quét năm thư mục cố định khi app khởi động. Việc quét chỉ nhìn các file nằm trực tiếp trong thư mục, không đi vào thư mục con và không xóa hoặc sửa file nguồn.

## Năm thư mục

Các thư mục nằm trực tiếp trong thư mục dùng để khởi chạy app. Với `ReelForge Studio.cmd`, `npm start` hoặc `npm run dev` chạy từ repository, đó chính là thư mục repository. `REELFORGE_HOME` chỉ chứa dữ liệu runtime và không đổi vị trí quét resource.

| Thư mục | Dùng cho | Định dạng |
| --- | --- | --- |
| `stickers` | Meme image hoặc video meme theo card | PNG, JPEG/JPG, WebP, MP4 |
| `meme sounds` | Âm thanh đi cùng meme image | MP3 |
| `transition sound` | Một transition sound cho cả project | MP3 |
| `intro sounds` | Intro Sound cho cả project | MP3 |
| `background audio` | Nhạc nền của project | MP3 |

Ví dụ:

```text
<thư-mục-khởi-chạy-app>\
├─ stickers\
├─ meme sounds\
├─ transition sound\
├─ intro sounds\
└─ background audio\
```

Tên thư mục phải đúng, gồm cả khoảng trắng trong `meme sounds`, `transition sound`, `intro sounds` và `background audio`.

## Thêm resource

1. Copy file hợp lệ vào đúng một trong năm thư mục.
2. Đặt file ngay trong thư mục, không đặt trong thư mục con.
3. Restart app.
4. Mở lại Editor để thấy danh sách mới.

Resource chỉ được thêm bằng cách copy file vào năm thư mục này rồi restart app.

Settings không có Resource Library. API vẫn đọc năm thư mục này để các picker trong Editor hiển thị resource đã quét.

App lưu bản managed theo hash nội dung để project và job đã xếp hàng không bị ảnh hưởng nếu file nguồn đổi tên. File nguồn không bị di chuyển, sửa hoặc xóa.

## Chọn resource trong project

- Meme image và meme sound phải được chọn thành một cặp trong từng card. Chỉ khi có đủ cả hai, cặp mới được lưu.
- Video meme phải là MP4 trong `stickers`. Video giữ audio gốc; có thể chọn thêm meme sound để phát chồng lên.
- Transition sound được chọn một lần ở cấp project và dùng chung trước card 2..N.
- Intro Sound dùng MP3 trong `intro sounds` và phát cùng card 1 tại `t=0`; Transition Sound chỉ dùng MP3 trong `transition sound`.
- Background music được chọn một lần ở cấp project.
- Không có lớp hình cố định trên template; hình trong `stickers` chỉ xuất hiện khi được chọn làm meme cho card.

## Thứ tự trong video

Timeline của project chạy như sau:

```text
card 1 + intro sound bắt đầu tại t=0
→ intro kết thúc: card 1 narration + background music bắt đầu
→ card content hoặc blank-card hold
→ meme image + sound, hoặc video meme (audio gốc + sound tùy chọn)
→ card sau xuất hiện + transition sound bắt đầu cùng lúc
→ card sau narration hoặc hold
```

Card đầu không có transition. Không có transition sau card cuối. Nếu card cuối có meme, meme đó là phần kết thúc.

Meme image và meme sound bắt đầu cùng lúc. Thời lượng hình meme bằng duration thực của meme sound; người dùng không đặt hai duration riêng. Video meme giữ audio gốc và có thể có meme sound chồng lên.

Background music bắt đầu sau intro, lặp đến hết timeline và tự động giảm khi narration hoặc effect phát. Nếu không chọn nhạc nền, video không có lớp nhạc nền.

## Card trống và bố cục

Card trống không gọi TTS: nó giữ hình trong 1–5 giây, mặc định 3 giây. Nếu mọi card đều trống, project không cần TTS hoặc API key.

Trong Preview, card, meme image và meme video dùng cùng UI manual: kéo visual để đổi vị trí, hoặc kéo một trong bốn góc để resize theo đúng aspect ratio và giữ toàn bộ rectangle trong canvas 9:16. Media dùng `contain`, không crop; mỗi card lưu layout card và layout meme độc lập. Chọn **Về bố cục template** để xóa override và fit lại visual trong slot template.

## Tốc độ đọc

Tốc độ đọc nằm trong khoảng `0.5×–2.0×`. TTS provider tạo audio gốc, sau đó FFmpeg cục bộ điều chỉnh tốc độ trước khi renderer ghép timeline. Vì vậy cùng một quy tắc áp dụng cho Google Cloud TTS, ElevenLabs và mọi model được chọn.

## Khi resource không hiện

Kiểm tra nhanh:

- file nằm trực tiếp trong đúng thư mục;
- sticker image là PNG/JPEG/WebP hoặc video meme là MP4;
- mọi audio (`meme sounds`, `transition sound`, `intro sounds`, `background audio`) là MP3 hợp lệ;
- app được khởi chạy từ đúng thư mục chứa năm resource folder;
- app đã được restart sau khi copy file.

Resource không hợp lệ sẽ không xuất hiện trong danh sách. Xem thêm [Xử lý sự cố](TROUBLESHOOTING.md).
