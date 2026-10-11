# Xử lý sự cố

Trước khi chẩn đoán, dừng các terminal cũ có thể đang giữ API hoặc worker. `npm run dev` chạy UI, API và worker; `npm start` chạy production supervisor.

## Kiểm tra nhanh

```powershell
node --version
npm --version
Invoke-WebRequest 'http://127.0.0.1:3000/api/health' | Select-Object -ExpandProperty Content
```

Health hợp lệ có `{"status":"ok"}`. Nếu không, restart app trước khi kiểm tra UI.

## Resource không xuất hiện trong UI

App chỉ quét trực tiếp, không đệ quy, năm thư mục sau khi khởi động:

```text
<thư-mục-khởi-chạy-app>\stickers\
<thư-mục-khởi-chạy-app>\meme sounds\
<thư-mục-khởi-chạy-app>\transition sound\
<thư-mục-khởi-chạy-app>\background audio\
<thư-mục-khởi-chạy-app>\intro sounds\
```

Kiểm tra:

1. File nằm ngay trong đúng thư mục, không nằm trong thư mục con.
2. Image là PNG/JPEG/WebP.
3. Audio là MP3 hợp lệ.
4. Đã copy file xong rồi restart app.
5. App được khởi chạy từ đúng thư mục chứa năm resource folder.

Resource mới không cần thao tác nào trong UI trước khi restart. File lỗi sẽ bị bỏ qua và log chỉ ghi tên file cùng mã lỗi, không ghi đường dẫn nguồn.

## Meme không được áp dụng

Meme chỉ được lưu khi có đủ cả image và sound. Hãy chọn lại cả hai resource trong cùng card rồi lưu project. Xóa meme sẽ xóa cả cặp.

Meme image và meme sound bắt đầu cùng lúc. Hình meme kết thúc theo duration thực của sound; không có trường nhập duration riêng.

## Transition không phát hoặc phát sai vị trí

Transition sound là một lựa chọn duy nhất ở cấp project, không phải lựa chọn riêng cho từng card. Transition chỉ phát trước card 2..N:

```text
meme của card trước
→ card sau xuất hiện + transition bắt đầu
→ transition kết thúc
→ narration card sau bắt đầu
```

Card đầu không có transition và card cuối không có transition sau nó. Nếu không chọn transition, các card nối tiếp mà không có effect này.

## Intro sound không phát đúng thứ tự

Intro sound là lựa chọn riêng ở đầu video. Card 1 hiển thị ngay khi intro bắt đầu; narration của card 1 và nhạc nền bắt đầu sau khi intro kết thúc.

## Nhạc nền không nghe hoặc bị quá lớn

Kiểm tra đã chọn một file trong nhóm `background audio` và restart app sau khi thêm file mới. Nhạc nền được lặp đến hết video và tự động giảm dưới narration/effect; đây là hành vi cố định, không có thanh chỉnh riêng.

Nếu không chọn nhạc nền, video vẫn render bình thường với narration và các effect đã chọn.

## Tốc độ TTS không thay đổi

Tốc độ hợp lệ là `0.5×–2.0×`. App tạo audio TTS gốc ở tốc độ chuẩn, sau đó dùng FFmpeg cục bộ để đổi tốc độ; provider/model, kể cả ElevenLabs, không quyết định bước này.

Sau khi đổi tốc độ:

1. Chờ project autosave hoàn tất.
2. Dùng Preview TTS để kiểm tra card hiện tại.
3. Nếu app đang chạy từ build cũ, dừng bằng `Ctrl+C`, chạy `npm run build`, rồi restart.
4. Enqueue job mới sau khi tốc độ đã lưu.

Cache cũ không làm hỏng audio; job mới sẽ tạo hoặc tái sử dụng audio đã điều chỉnh đúng tốc độ.

## Key không hợp lệ hoặc quota 429

Kiểm tra `.env.local` nằm trong đúng `REELFORGE_HOME` và tên biến chính xác:

```text
GOOGLE_TTS_API_KEY=...
ELEVENLABS_API_KEY=...
```

Sau khi đổi key, restart cả API và worker. HTTP 401/403 hoặc lỗi validation không được retry. HTTP 429 và lỗi 5xx được retry tối đa ba lần với backoff 2, 5 và 15 giây.

Không paste key vào log, screenshot, project JSON hoặc issue. UI chỉ hiển thị trạng thái và phần suffix đã mask.

## FFmpeg hoặc ffprobe không chạy

Renderer dùng binary bundled, không cần cài FFmpeg hệ thống:

```powershell
npm ci
npm run setup
npm run build
```

Nếu antivirus cách ly binary trong `node_modules`, kiểm tra quarantine và chỉ allowlist khi bạn hiểu rõ nguồn dependency. Sau đó chạy một job nhỏ để preflight kiểm tra lại media.

## Job failed, cancel hoặc retry

Khi job failed:

1. Ghi lại job ID, attempt và thông báo trong Queue.
2. Kiểm tra script không rỗng, card mở được, gameplay phát được và resource đã qua preflight.
3. Nếu lỗi provider tạm thời, chờ network/quota ổn định rồi bấm Retry.
4. Nếu đang render, bấm Cancel và chờ trạng thái settle trước khi retry.

Attempt failed có thể giữ manifest và log để chẩn đoán; workspace của job thành công hoặc bị hủy thường được dọn. Không xóa `queue.sqlite`, `queue.sqlite-wal` hoặc `queue.sqlite-shm` để sửa queue.

## Output không tạo được hoặc không mở được

Kiểm tra output directory có quyền ghi và còn đủ dung lượng. Output được tạo tạm rồi đổi tên atomically; file cũ không bị ghi đè.

Output chuẩn là H.264/AAC, 720×1280, 30 fps, `yuv420p`, phù hợp với Chrome, Edge và các trình phát Windows phổ biến. Nếu gameplay không được ffprobe đọc, hãy dùng một video background khác rồi tạo lại template.

## Restart an toàn

1. Nếu đang render, bấm **Cancel** và chờ job settle nếu có thể.
2. Nhấn `Ctrl+C` ở terminal root.
3. Chờ process Node/FFmpeg biến mất.
4. Khởi động lại `npm start` hoặc `npm run dev`.

Sau restart, worker sẽ recovery job đang chạy theo trạng thái queue. Resource mới cũng được quét lại ở lần khởi động này.

## Liên kết

- [README](../README.md)
- [Thư viện tài nguyên](RESOURCE_LIBRARY.md)
- [Hướng dẫn template sạch](CLEAN_TEMPLATE_GUIDE.md)
- [Sao lưu và vòng đời dữ liệu](DATA_AND_BACKUP.md)
