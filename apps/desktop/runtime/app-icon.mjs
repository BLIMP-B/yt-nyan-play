import { fileURLToPath } from 'node:url';

export const APP_ID = 'jp.blimp.nyantalkdamare';
export const APP_ICON = fileURLToPath(new URL(process.platform === 'win32' ? '../assets/app.ico' : '../../../extension/furoneko70furoneko70.png', import.meta.url));
