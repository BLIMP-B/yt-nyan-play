import { safeStorage } from 'electron';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export class Vault {
  constructor(directory) { this.path = join(directory, 'bot-token.bin'); }
  available() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
  save(token) {
    if (typeof token !== 'string' || token.length > 300 || !token.trim()) throw new Error('有効なBotトークンを入力してください');
    if (!this.available()) throw new Error('OSの暗号化保管を利用できません。この環境ではトークンを保存しません');
    writeFileSync(this.path, safeStorage.encryptString(token.trim()), { mode: 0o600 });
  }
  read() { if (!existsSync(this.path)) return ''; if (!this.available()) throw new Error('OSの認証情報保管にアクセスできません'); return safeStorage.decryptString(readFileSync(this.path)); }
  hasToken() { return existsSync(this.path); }
  clear() { if (existsSync(this.path)) unlinkSync(this.path); }
}
