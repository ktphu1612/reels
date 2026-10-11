# Sao lưu và vòng đời dữ liệu

ReelForge là app local, không có cloud backup và không tự đồng bộ dữ liệu. Hãy xem `<base>` là thư mục dữ liệu chính:

- `<base> = REELFORGE_HOME` nếu process environment có biến này;
- với `npm run dev`, `npm start` hoặc launcher, nếu không có biến thì `<base>` là thư mục repository;
- khi chạy trực tiếp server/worker ở workspace, nếu không có biến thì `<base>` là working directory của process đó.

## Cấu trúc dữ liệu

```text
<base>\
├─ .env.local
├─ data\
│  ├─ assets\
│  ├─ projects\<id>\project.json
│  ├─ templates\<id>\template.json
│  ├─ uploads\                  # multipart tạm, thường được dọn sau request
│  ├─ cache\tts\               # audio TTS cache
│  ├─ jobs\<jobId>\attempt-<n>\ # manifest/workspace/log
│  └─ queue.sqlite*
└─ outputs\
```

### Nên backup

- `data/projects/`: project JSON và thứ tự card/script.
- `data/templates/`: template manifest.
- `data/assets/`: bản copy bất biến của gameplay, card, sticker, thumbnail.
- `outputs/`: MP4 đã xuất mà bạn cần giữ.
- `data/queue.sqlite`, `data/queue.sqlite-wal`, `data/queue.sqlite-shm` nếu tồn tại: queue, attempts, trạng thái, events, settings và lịch sử lỗi.
- `.env.local`: key TTS plaintext; chỉ backup vào nơi mã hóa/quyền truy cập hạn chế.

### Có thể tái tạo nhưng có chi phí/thời gian

- `data/cache/tts/` là cache audio theo request. Xóa cache không xóa project, nhưng các job sau sẽ gọi provider lại và có thể phát sinh phí/quota.
- `data/jobs/` chứa workspace attempt và log. Job thành công/hủy thường được dọn; log/manifest của job lỗi có thể hữu ích để chẩn đoán. Có thể bỏ các workspace sau khi đã ghi nhận lỗi, nhưng hãy dừng app trước.

Không xóa `data/assets` chỉ vì đã xóa project/template: project/template delete hiện xóa manifest directory, còn asset blob content-addressed có thể vẫn được giữ lại và có thể được dùng chung. Dọn asset không dùng là công việc thủ công và cần chắc chắn không còn project/template tham chiếu.

## Quy trình backup an toàn trên Windows

1. Dừng UI, worker và API bằng `Ctrl+C`.
2. Xác nhận không còn process Node/FFmpeg của ReelForge:

   ```powershell
   Get-Process node,ffmpeg,ffprobe -ErrorAction SilentlyContinue
   ```

3. Xác định base directory:

   ```powershell
   $base = if ($env:REELFORGE_HOME) { $env:REELFORGE_HOME } else { (Get-Location).Path }
   $base
   ```

4. Copy toàn bộ `<base>` sang ổ backup. Ví dụ:

   ```powershell
   $backup = 'E:\Backups\ReelForge\2026-08-24'
   New-Item -ItemType Directory -Force $backup | Out-Null
   Get-ChildItem -LiteralPath $base -Force | ForEach-Object {
     Copy-Item -LiteralPath $_.FullName -Destination $backup -Recurse -Force
   }
   ```

   Nếu dùng wildcard với `Copy-Item`, kiểm tra lại `$base` và `$backup` trước khi chạy. Không đặt `$backup` bên trong `$base`.

5. Kiểm tra backup có `data\queue.sqlite*`, `data\projects`, `data\templates`, `data\assets`, `outputs` và `.env.local` (nếu bạn chọn backup secret).
6. Chỉ khởi động lại app sau khi copy hoàn tất.

SQLite chạy WAL. Copy riêng `queue.sqlite` trong lúc process còn mở có thể bỏ sót dữ liệu đang nằm ở `-wal`; dừng app và copy cả nhóm file là yêu cầu an toàn.

## Restore

1. Dừng app.
2. Cài dependency/build source mới nếu cần, nhưng không để build output ghi đè base data.
3. Chọn base directory restore và đặt `REELFORGE_HOME` tới đó.
4. Restore `.env.local` với quyền NTFS hạn chế; không dán key vào shell history nếu không cần.
5. Restore `data` và `outputs`, giữ nguyên tên file hash.
6. Chạy health check, mở Projects/Queue, kiểm tra một project và một output trước khi batch render.

Nếu chỉ cần project/template mà không cần queue history, vẫn phải restore `data/assets` vì JSON chỉ trỏ tới asset hash tương đối. Nếu thiếu asset, preflight sẽ báo asset missing trước khi gọi TTS.

## Retention và xóa dữ liệu

Không có TTL/retention job tự động trong source hiện tại. Setup/update không được tự xóa:

- project hoặc template;
- card/gameplay/sticker asset;
- output MP4;
- queue history, attempt hoặc event;
- `.env.local` và credential.

Xóa project/template từ UI/API chỉ xóa manifest tương ứng; asset có thể vẫn tồn tại. Xóa output và cache là thao tác thủ công sau khi dừng app. Xóa `queue.sqlite*` đồng nghĩa bỏ queue history và thông tin recovery; chỉ làm sau khi backup và chắc chắn không còn job cần giữ.

Khi “uninstall” source, hãy xóa code/`node_modules` riêng khỏi base data. Đừng dùng thao tác xóa đệ quy trên một đường dẫn chưa kiểm tra; xác nhận tuyệt đối `<base>` trước.

## Bảo mật backup

`.env.local` chứa key plaintext. Không đưa file này lên Git, cloud drive công khai, ticket, screenshot hoặc gửi qua chat. Nếu backup cần rời máy, dùng ổ/volume mã hóa và phân quyền chỉ cho user cần thiết. Khi nghi ngờ key bị lộ, revoke/rotate ở provider rồi cập nhật `.env.local` và khởi động lại worker để redaction set được refresh.

Quay lại [README](../README.md) hoặc xem [Xử lý sự cố](TROUBLESHOOTING.md).
