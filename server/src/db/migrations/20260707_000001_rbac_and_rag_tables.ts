import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Db): void {
  // 1. Thêm cột role vào bảng users nếu chưa tồn tại
  if (!hasColumn(db, 'users', 'role')) {
    db.prepare("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'").run();
  }

  // 2. Tạo bảng documents lưu thông tin tài liệu đã tải lên
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      file_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 3. Tạo bảng document_chunks lưu các phân đoạn văn bản và vector tương ứng
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL, -- Lưu mảng JSON vector số thực
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 4. Tạo bảng skills lưu trữ trợ lý chuyên gia (system prompts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      system_prompt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed các Skills mặc định ban đầu nếu bảng trống
  const count = db.prepare('SELECT COUNT(*) as c FROM skills').get() as { c: number };
  if (count.c === 0) {
    const insert = db.prepare('INSERT INTO skills (name, description, system_prompt) VALUES (?, ?, ?)');
    db.transaction(() => {
      insert.run(
        'Chuyên gia GIS OpenLayers 6',
        'Hỗ trợ lập trình viên xây dựng module bản đồ hiệu quả, tái sử dụng VectorSource, kiểm soát event listener và tối ưu style.',
        'Bạn là một chuyên gia cao cấp về GIS và thư viện bản đồ OpenLayers 6. Hãy trả lời các câu hỏi về bản đồ, ưu tiên tái sử dụng VectorSource, dọn dẹp các listener và interaction khi không dùng, sử dụng cached styles để tránh khởi tạo lại style cho mỗi feature.'
      );
      insert.run(
        'Quy chuẩn Code Vue 2 + Vuetify 2',
        'Định hình phong cách code Vue 2 Options API sạch, tối ưu hóa computed property và quản lý state thông qua Vuex.',
        'Bạn là chuyên gia lập trình Vue 2 Options API kết hợp Vuetify 2. Cấm viết theo kiểu Vue 3 Composition API hay dùng thẻ <script setup>. Ưu tiên dùng computed hơn watch, cập nhật state immutable, sử dụng Vuex làm Single Source of Truth.'
      );
      insert.run(
        'Thiết kế Laravel Service Pattern',
        'Hướng dẫn viết code Backend PHP/Laravel sạch dựa trên Service Pattern và tránh lỗi truy vấn N+1.',
        'Bạn là kiến trúc sư hệ thống PHP/Laravel 7.2 - 7.3. Hãy tư vấn viết code theo đúng Service Pattern, luôn select() các cột cần thiết, eager load các quan hệ bằng với() để tránh tối đa lỗi N+1 queries. Không đưa business logic vào Controller.'
      );
    })();
  }
}

export function down(db: Db): void {
  // Tránh xóa các bảng/cột nếu không cần thiết để bảo toàn dữ liệu theo quy tắc dự án
  // Chỉ rollback cấu trúc bảng mới tạo
  db.exec(`DROP TABLE IF EXISTS skills;`);
  db.exec(`DROP TABLE IF EXISTS document_chunks;`);
  db.exec(`DROP TABLE IF EXISTS documents;`);
}
