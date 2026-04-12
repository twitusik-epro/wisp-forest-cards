module.exports = {
  apps: [{
    name:         'forest-cards',
    script:       'server.js',
    cwd:          '/opt/gry/Wisp - Forest Cards',
    instances:    1,
    autorestart:  true,
    watch:        false,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
    },
    error_file:  '/var/log/forest-cards/error.log',
    out_file:    '/var/log/forest-cards/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
