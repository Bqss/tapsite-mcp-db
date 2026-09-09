module.exports = {
  apps: [
    {
      name: "tapsite-db-mcp",
      script: "dist/index.js",
      node_args: "--env-file=.env",
      env: {
        MCP_PORT: "3100",
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
