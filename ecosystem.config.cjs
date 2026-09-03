module.exports = {
  apps: [
    {
      name: "tapsite-db-mcp",
      script: "dist/index.js",
      cwd: __dirname,
      env: {
        PGHOST: "127.0.0.1",
        PGPORT: "3309",
        PGUSER: "postgres",
        PGPASSWORD: "CHANGE_ME",
        PGDATABASE: "tapsite",
        MCP_PORT: "3100",
        MCP_DB_MAX_ROWS: "500",
        MCP_AUTH_TOKEN: "Allahuakbar21.a",
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      watch: false,
      out_file: `${__dirname}/logs/out.log`,
      error_file: `${__dirname}/logs/error.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
