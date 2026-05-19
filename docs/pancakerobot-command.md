# `pancakerobot` terminal command

One command to run the local Pancake Robot stack from anywhere after linking the repo.

## First-time install on a Mac

```bash
cd /Users/kchapman/PancakeRobot
git pull --rebase
chmod +x bin/pancakerobot scripts/pancake.sh
npm link
```

## Run the full stack

```bash
pancakerobot
```

Default behavior is equivalent to:

```bash
pancakerobot stack
```

It runs through `scripts/pancake.sh`, which:

- uses the repo-local Node runtime pinned by the project
- installs dependencies if needed
- rebuilds native modules when needed
- starts the web UI
- starts workflow admin
- starts the Telegram bot
- starts ngrok unless disabled

## Common commands

```bash
pancakerobot doctor      # verify runtime/dependencies/native modules
pancakerobot web         # web UI only
pancakerobot telegram    # Telegram bot only
pancakerobot stack       # web + workflow admin + Telegram + ngrok
pancakerobot test        # test suite
pancakerobot cleanup     # catalog cleanup
```

## Local-only mode

Disable ngrok when you only need localhost:

```bash
PANCAKE_DISABLE_NGROK=true pancakerobot
```

## Static ngrok domain

If you have a reserved ngrok domain, put this in `.env`:

```env
NGROK_DOMAIN=your-static-domain.ngrok-free.app
```

Then run:

```bash
pancakerobot
```

The stack will set `PUBLIC_APP_BASE_URL` and `PUBLIC_BASE_URL` from the ngrok tunnel so Telegram links point to the public URL.
