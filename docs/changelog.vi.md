## v0.1.100 — 2026-08-10

### Tác nhân AI

- **Kiro CLI trở thành một loại phiên hạng nhất.** Phiên Kiro có nút riêng trong cây, có chấm trạng thái Đang làm việc / Đang chờ chuẩn xác do chính lifecycle hooks của Kiro điều khiển, có thông báo khi một lượt kết thúc, tự động tiếp tục đúng cuộc hội thoại cũ khi bạn mở lại nút, có tham số khởi chạy cùng công tắc bỏ qua xác nhận, và khởi chạy qua vspawn — mọi thứ mà các tác nhân khác đã có. heddle sao chép tác nhân Kiro mặc định của bạn thành một tác nhân `vlx-term` riêng, thêm lifecycle hooks chỉ quan sát vào bản sao rồi khởi chạy bản sao đó — tệp tác nhân của bạn không bao giờ bị sửa, còn prompt, công cụ và máy chủ MCP thì đi theo nguyên vẹn. Kiro không có hook yêu cầu quyền, nên chấm trạng thái vẫn là Đang làm việc trong lúc chờ bạn phê duyệt.

### Sửa lỗi

- **Chương trình khởi chạy từ terminal không còn thừa hưởng môi trường của chính AppImage (Linux).** Trình khởi chạy AppImage trỏ `PYTHONHOME`, `PYTHONPATH`, `PERLLIB`, `QT_PLUGIN_PATH` và các đường dẫn plugin GStreamer vào thư mục mount tạm thời của gói, đồng thời đặt các thư mục trong gói lên trước mọi thứ khác trong `PATH` và `LD_LIBRARY_PATH`. Terminal giao toàn bộ môi trường của nó cho shell mà nó khởi chạy, nên `python3` của hệ thống đi tìm thư viện chuẩn bên trong gói rồi từ chối chạy, còn những chương trình liên kết động khác thì nạp bản sao thư viện trong gói thay vì bản của hệ thống. heddle nay loại bỏ các đường dẫn của gói trước khi khởi chạy shell hoặc công cụ bên ngoài, và giữ nguyên những giá trị do chính bạn đặt. `APPDIR` và `APPIMAGE` vẫn hiển thị, nên các chương trình cần kiểm tra xem mình có đang chạy từ AppImage hay không vẫn có câu trả lời. Chỉ các bản dựng AppImage bị ảnh hưởng; gói deb, macOS và Windows vẫn như trước.

## v0.1.99 — 2026-08-09

### Terminal

- **Shift+Enter xuống dòng thay vì gửi đi.** Terminal không có mã hóa cho Enter kèm phím bổ trợ, nên các CLI tác nhân như Claude Code và Codex chỉ nhận được một ký tự xuống dòng thông thường và gửi nội dung đi khi bạn còn đang viết. heddle nay phát ESC+CR, đúng chuỗi mà những công cụ đó mong đợi từ ánh xạ phím của iTerm2, nhờ vậy nhập nhiều dòng đã dùng được — kể cả trên macOS, nơi trước đây bộ xử lý phím tùy chỉnh hoàn toàn không được cài. Trong lúc gõ bằng bộ gõ, mọi thứ giữ nguyên: Enter vẫn dùng để chọn từ gợi ý.

### Dự án và tổ chức

- **Làm mới trạng thái của một phiên duy nhất.** Trong khung đang bật bộ lọc trạng thái, mỗi phiên có thêm thao tác «Làm mới trạng thái», đánh giá lại đúng phiên đó theo điều kiện của chính khung ấy rồi thêm vào hoặc loại bỏ, trong khi mọi phiên khác giữ nguyên vị trí. Thao tác thuộc về khung đã mở menu, nên các lần chia lồng nhau không bao giờ mượn bộ lọc của khung khác. Kết quả được lưu riêng theo từng khung và khôi phục sau khi khởi động lại.
- **Bỏ đánh dấu chỉ cần một cú nhấp.** Chọn lại biểu tượng cảm xúc đang áp dụng sẽ gỡ bỏ nó, nên mục riêng để bỏ đánh dấu cùng đường phân cách đã được loại đi. Huy hiệu biểu tượng cảm xúc trên nút lọc cũng bị bỏ: phần làm nổi bật đã cho biết bộ lọc đánh dấu đang bật, còn cụ thể là biểu tượng nào thì menu có ghi.

### Sửa lỗi

- **Tích hợp desktop của AppImage trên Linux cài được trên mọi máy.** Biểu tượng đi kèm là một liên kết tượng trưng trỏ tới đường dẫn tuyệt đối trên máy build, nên những công cụ như Gear Lever và AppImageLauncher không trích xuất được, dù bản thân ứng dụng vẫn chạy bình thường. Nay liên kết đã là tương đối. Yêu cầu glibc công bố cũng được đính chính thành 2.35 sau khi đo cả các thư viện đi kèm chứ không riêng tệp thực thi, nghĩa là Ubuntu 22.04 là bản phân phối cũ nhất mà ứng dụng desktop hỗ trợ.

## v0.1.98 — 2026-08-02

### Tác nhân AI

- **Grok Build trở thành tác nhân hạng nhất trong heddle.** Cài đặt, khởi chạy và tiếp tục Grok 4.5 với ID phiên ổn định, lifecycle hooks chính thức, trạng thái làm việc và quyền chính xác, bản ghi hội thoại đã hợp nhất, chi tiết sử dụng cùng biểu tượng chính thức thích ứng theo giao diện trên máy tính, trình duyệt và thiết bị di động.

### Dự án và tổ chức

- **Chia thanh bên dự án thành các chế độ làm việc độc lập.** Mọi khung cây đều có thể tiếp tục chia xuống dưới và khôi phục sau khi khởi động lại phần tìm kiếm, bộ lọc trạng thái và biểu tượng cảm xúc, trạng thái thu gọn cùng tỷ lệ kích thước riêng. Tất cả các khung vẫn là hình chiếu của cùng một cây dự án do backend quản lý, vì vậy thay đổi luôn đồng bộ mà không nhân đôi dữ liệu nghiệp vụ.
- **Đánh dấu và lọc nút mà không mất ngữ cảnh.** Dự án, nhóm và phiên đều có thể mang dấu biểu tượng cảm xúc. Một vùng chứa được đánh dấu sẽ giữ nguyên toàn bộ cây con; thành viên theo trạng thái vẫn ổn định trong lúc làm việc; cả bổ sung động và làm mới thủ công đều được hỗ trợ; điều kiện trạng thái và biểu tượng cảm xúc được kết hợp theo phép hợp.
- **Tạo dự án trống ngay tại chỗ.** Chọn thư mục cha, xác thực tên rồi tạo và nhập thư mục trong cùng một quy trình. Nếu chỉ bước nhập gặp lỗi, hệ thống sẽ thử lại bước đó mà không tạo thư mục trùng lặp.

### Giao diện

- **Chia sẻ heddle ở nơi cộng đồng của bạn hiện diện.** Hộp thoại chia sẻ nay hỗ trợ WeChat Moments, Weibo, Xiaohongshu, X, Reddit, Hacker News, LinkedIn, Facebook, Telegram và WhatsApp, kèm quy trình mã QR cho WeChat và lời mời chia sẻ trong hộp thoại cập nhật.
- **Những tương tác nhỏ trở nên chỉn chu hơn.** Có thể đổi tên tab terminal tạm thời trước khi chuyển thành phiên đã lưu. Các ô nhập thông thường tắt tự động viết hoa trên bàn phím di động mà không làm thay đổi thao tác nhập trong terminal.

## v0.1.97 — 2026-07-25

### Tác nhân AI

- **Phiên không còn kẹt ở trạng thái “đang làm việc”.** Codex báo hoạt động công cụ và kết thúc lượt qua các tiến trình ngắn hạn riêng biệt, nên callback có thể đến sai thứ tự và khiến một lượt đã kết thúc vẫn hiển thị là đang chạy. Giờ đây các báo cáo giữa lượt đến sau khi chính lượt đó kết thúc sẽ bị loại bỏ, và một hook kết thúc phiên mới bao quát những phiên thoát mà không phát sự kiện hoàn tất.
- **Lượt bị ngắt trở lại bình thường trong vài giây.** Khi nhấn Esc hoặc gặp lỗi luồng, lượt của Claude và Codex kết thúc mà không gửi bất kỳ callback hoàn tất nào. Sau sáu giây terminal hoàn toàn im lặng, phiên đó được lặng lẽ chỉnh về trạng thái chờ và không hiện thông báo “đã trả lời”.

### Giao diện

- **Phím tắt chia khung đáng tin cậy trên macOS.** Chia sang phải (Cmd+D) và chia xuống dưới (Cmd+Shift+D) nay được đăng ký thành lệnh menu Terminal gốc, nên macOS không còn chặn tổ hợp phím trước khi heddle nhận được.
- **Mỗi lần nhấn phím chỉ lưu một lần.** Cmd+S trước đây được xử lý bởi cả phím tắt toàn cục lẫn trình soạn thảo đang có tiêu điểm, nên có thể ghi cùng một tệp hai lần chỉ trong một lần nhấn.

## v0.1.96 — 2026-07-23

### Tác nhân AI

- **Trạng thái Codex tin cậy lifecycle hooks thay vì phỏng đoán từ terminal.** Phiên Codex mới chỉ dùng lifecycle hooks chính thức làm nguồn trạng thái hoạt động. Bắt tay `SessionStart` xác minh đường kết nối, callback bị thiếu được hiển thị là “Không có trạng thái”, còn văn bản hoặc hoạt động đầu ra của terminal không thể ghi đè trạng thái đang làm việc, cần xác nhận hay đã hoàn tất.
- **Mức sử dụng Codex được cập nhật kịp thời hơn sau mỗi lượt.** Bảng Info hiển thị ngay snapshot rollout cục bộ, đối chiếu với giới hạn trực tiếp, làm mới thêm một lần sau khi Codex ghi snapshot token cuối cùng và bỏ qua phản hồi đến muộn từ phiên trước.

### Giao diện

- **Chọn chính xác trong cây dự án trên macOS.** Các hàng ảo không còn phụ thuộc vào transform của compositor, nhờ đó tọa độ hit-test cũ của WKWebView không gửi thao tác di chuột, nhấp hoặc kéo tới một hàng khác sau khi cuộn hay cập nhật cây.

## v0.1.95 — 2026-07-21

### Tác nhân AI

- **Kimi Code và Zoo Code đã có trong cây phiên.** heddle giờ có thể khởi chạy, tiếp tục, cài đặt và cấu hình cả hai tác nhân. Kimi dùng lifecycle hooks chính thức để báo cáo chính xác trạng thái làm việc, quyền và chờ; Zoo Code giữ định danh tác vụ ổn định và dùng nhận diện terminal khi không có hooks bên ngoài.
- **Làm mới trực tiếp mức sử dụng Codex.** Bảng Info truy vấn Codex app server để lấy giới hạn hiện tại và vẫn dùng ảnh chụp rollout cục bộ làm phương án tương thích dự phòng.

### Dự án và terminal

- **Mở dự án bằng `vela <path>`.** Bản đóng gói có thể cài lệnh shell kiểu VS Code. Lần gọi thứ hai chuyển dự án tới cửa sổ heddle hiện có thay vì mở một phiên bản trùng lặp.
- **Git clone có tiến độ và có thể hủy.** Clone Project hiển thị giai đoạn, phần trăm và thời gian, cảnh báo khi bị đình trệ, đồng thời có thể hủy toàn bộ cây tiến trình Git mà không để lại thư mục dở dang. Thông tin xác thực và query tokens được che trong lỗi và nhật ký kiểm toán.
- **Terminal WSL trên Windows.** Mọi bản phân phối WSL đã cài được phát hiện và hiển thị cùng PowerShell, cmd và Git Bash cho terminal thông thường. Phiên tác nhân vẫn dùng Windows host shell để hooks và đường dẫn thực thi hoạt động tin cậy.

### Giao diện và độ tin cậy

- **Kiểm soát phiên nền rõ ràng hơn.** Trình đơn hiển thị trạng thái trực tiếp của từng phiên và hộp thoại vượt giới hạn có thể kết thúc nhiều tab đã chọn cùng lúc.
- **Vòng đời an toàn hơn và ghi chú đa ngôn ngữ.** Ứng dụng hỏi xác nhận trước khi dừng phiên đang chạy; định danh lifecycle chính xác của Codex được ưu tiên hơn quét rollout mơ hồ; ghi chú cập nhật hỗ trợ mọi ngôn ngữ tích hợp.

## v0.1.94 — 2026-07-12

### Bản địa hóa

- **Giao diện tiếng Việt.** Tiếng Việt hiện có trong trình chọn ngôn ngữ và được tự động chọn khi hệ thống sử dụng ngôn ngữ vùng tiếng Việt.

### Trình duyệt

- **Khởi động trình duyệt tích hợp nhanh hơn.** Mỗi tab trình duyệt hiện có lối tắt một lần nhấp cho ChatGPT, Claude, Gemini và Google. Menu ngữ cảnh của dự án và nhóm cũng có thể tạo trực tiếp một trang trình duyệt cố định tại phần tương ứng trong cây phiên.

### Hình ảnh và tài liệu

- **Dán đường dẫn hình ảnh đáng tin cậy trên macOS.** Khi WebKit không cung cấp hình ảnh đã sao chép dưới dạng tệp, heddle sẽ đọc hình ảnh từ bảng nhớ tạm gốc và vẫn tải lên dưới dạng đường dẫn tệp, thay vì âm thầm chuyển sang phần giữ chỗ hình ảnh gốc của agent. Cửa sổ từ xa luôn hiển thị cài đặt dán hình ảnh, giải thích vì sao cần chế độ đường dẫn tệp và vô hiệu hóa tùy chọn gốc không khả dụng.
- **Dán hình ảnh vào tài liệu mã nguồn.** Trình soạn thảo mã nguồn hiện chấp nhận hình ảnh từ bảng nhớ tạm. Tài liệu Markdown đã lưu sẽ đặt hình ảnh bên cạnh tài liệu trong `assets/` và chèn cú pháp hình ảnh Markdown có tính di động; bản nháp chưa lưu sẽ nhúng dữ liệu hình ảnh để không bị mất khi các tệp tạm thời được dọn dẹp.

### Giao diện

- **Menu ngữ cảnh luôn hiển thị và nhắm đúng mục.** Menu mở gần mép phải được đo và dịch chuyển chính xác. Khi nhấp chuột phải vào một nút trong cây, giờ đây chỉ mục tiêu của menu được tô sáng mà không làm thay đổi lựa chọn hiện có; menu nhóm cũng có một terminal giới hạn trong nhóm đó.
- **Hiển thị chỉnh sửa và nhãn trạng thái gọn gàng hơn.** Văn bản mã nguồn không còn hiển thị các chữ ghép phông giống mũi tên cho những chuỗi như chú thích HTML, phần trăm mức sử dụng được ghi rõ là đã dùng và menu ngữ cảnh gốc không liên quan của WebView chủ không còn xuất hiện phía sau menu của heddle.

### Sửa lỗi

- **Codex vẫn nằm trong lịch sử terminal thông thường.** Các phiên Codex do heddle khởi chạy giờ sử dụng chế độ terminal nội tuyến. Vì vậy, nhấn Esc để ngắt hoặc quay lại sẽ không còn chuyển đổi bộ đệm màn hình terminal và đưa khung nhìn lịch sử cuộn lên đầu. Cấu hình Codex của người dùng không bị thay đổi.
