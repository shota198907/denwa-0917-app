FROM node:18-slim

# pnpm を corepack で有効化
RUN corepack enable

WORKDIR /usr/src/app

# 依存定義のみ先にコピー（レイヤキャッシュの効率化）
COPY package.json ./

# 依存インストール（dev も入れてビルド、その後 dist を実行）
RUN pnpm install

# 残りのソースをコピー
COPY . .

# TypeScript ビルド
RUN pnpm run build

ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "start"]
