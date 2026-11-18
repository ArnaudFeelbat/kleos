// Vite (electron-vite and vitest) inlines `?raw` imports as strings.
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
