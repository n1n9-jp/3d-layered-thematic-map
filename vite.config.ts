import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // ビルド結果をサブパスに置いても動くよう、アセットを相対パスで参照する
  base: './',
  plugins: [react()],
});
