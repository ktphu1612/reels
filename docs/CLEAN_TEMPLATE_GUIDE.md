# Hướng dẫn tạo template sạch

Template sạch là gameplay nền để ReelForge đặt card và các lớp meme theo thời gian. Template không chứa chữ, subtitle, watermark hoặc một lớp hình cố định.

## Checklist nhanh

- Gameplay thuộc quyền sử dụng của bạn hoặc có license phù hợp.
- Video không có subtitle, watermark, logo, notification, webcam hoặc chat overlay.
- Khung hình dọc 9:16 là tốt nhất; video ngang sẽ được scale/crop để phủ canvas 720×1280.
- Nếu gameplay có audio, renderer vẫn tắt audio đó trong output.
- Card là ảnh hoàn chỉnh PNG/JPEG/WebP; script được nhập riêng trong project.
- Meme image và meme sound được chọn từ [Thư viện tài nguyên](RESOURCE_LIBRARY.md), không nằm trong template gameplay.

## Gameplay background

1. Chọn một đoạn gameplay sạch, ưu tiên 9:16 hoặc có vùng trung tâm an toàn.
2. Loại bỏ chữ và thành phần cố định không muốn xuất hiện trong mọi video.
3. Tránh đặt HUD quan trọng vào vùng card hoặc meme.
4. Đảm bảo video phát được trước khi tạo template. Nếu ffprobe không đọc được video, job sẽ bị chặn trước khi gọi TTS.

Renderer xử lý background theo chuỗi:

```text
scale để phủ kín → crop phần thừa → 720×1280 → 30 fps
```

Gameplay chạy từ đầu và được lặp nếu ngắn hơn timeline. Audio gameplay luôn bị tắt.

## Định dạng

| Vai trò | Bắt buộc | Định dạng | Ghi chú |
| --- | --- | --- | --- |
| Gameplay background | Có | MP4, MOV, WebM | Video hợp lệ, không cần audio. |
| Card image | Có cho mỗi card | PNG, JPG/JPEG, WebP | Ảnh hoàn chỉnh, render bằng `contain`. |
| Meme image | Tùy chọn theo card | PNG, JPG/JPEG, WebP | Chọn cùng một meme sound. |
| Audio effect, intro sound/music | Tùy chọn | MP3 | Được chọn từ năm thư mục tài nguyên; intro sound nằm trong `intro sounds`. |
| Thumbnail | Không | PNG, JPG/JPEG, WebP | Chỉ giúp nhận diện template. |

Đổi đuôi file không làm file sai định dạng trở thành hợp lệ. File image phải đọc được; file audio phải có duration mà ffprobe đo được.

## Vùng hiển thị mặc định

Các giá trị là normalized rectangle, tính từ góc trên trái:

| Lớp | x | y | width | height | Pixel trên 720×1280 |
| --- | ---: | ---: | ---: | ---: | --- |
| Card | `0.05` | `0.38` | `0.90` | `0.25` | `36, 486, 648×320` |
| Meme | `0.30` | `0.63` | `0.40` | `0.31` | `216, 806, 288×397` |

Mỗi rectangle phải nằm trọn trong canvas: `x + width <= 1` và `y + height <= 1`.

Ảnh card và meme dùng `contain`, nên ảnh không bị crop. Chừa safe margin quanh nội dung để chữ không sát mép màn hình.

## Thứ tự phát

Với mỗi card, timeline là:

```text
card 1 hiển thị + intro sound bắt đầu (nếu chọn)
→ intro sound kết thúc
→ narration card 1 + nhạc nền bắt đầu
→ meme image + meme sound (nếu chọn đủ một cặp)
→ card sau xuất hiện và transition sound bắt đầu
→ transition sound kết thúc
→ narration của card sau
```

Transition sound là một lựa chọn duy nhất ở cấp project, chỉ dùng trước card 2..N. Card cuối không có transition sau nó. Nếu card cuối có meme pair, đó là meme kết thúc video. Thời lượng meme image luôn bằng duration thực của meme sound và không chỉnh riêng được.

Nhạc nền được lặp đến hết timeline và tự động giảm trong lúc narration/effect phát. Intro sound là tùy chọn và chỉ phát ở đầu video; không có subtitle hay audio gameplay trong output.

## Tạo template và kiểm tra

1. Chọn gameplay background và thumbnail tùy chọn trong phần Templates.
2. Kiểm tra preview ở tỷ lệ 9:16.
3. Tạo project thử với hai card có script ngắn.
4. Chọn resource, nghe Preview TTS, rồi render một job nhỏ.
5. Mở MP4 bằng Chrome, Edge hoặc trình phát Windows để kiểm tra bố cục và âm thanh.

Tốc độ đọc được chọn trong khoảng `0.5×–2.0×` và xử lý cục bộ bằng FFmpeg sau khi TTS tạo audio gốc. Template không quyết định tốc độ đọc.

## Bản quyền

Bạn chịu trách nhiệm về quyền sử dụng gameplay, card, meme resource, voice provider và mọi nội dung đưa vào video. Kiểm tra license và quyền thương mại trước khi xuất bản.

Quay lại [README](../README.md) hoặc xem [Xử lý sự cố](TROUBLESHOOTING.md).
