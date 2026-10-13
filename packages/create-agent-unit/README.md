# create-agent-unit

Start a new [agent-unit](https://github.com/farming-labs/agent-unit) app:

```sh
npm create agent-unit@latest my-agent
```

It asks for the agent framework, who runs it, the hosts to deploy to, the model provider and extras,
and writes an app with one working agent, a `build` script for each host (with `start` or `deploy`
where the host has one) and a README with each host's steps. It is the same as `npx agent-unit init`,
and takes the same flags:

```sh
npm create agent-unit@latest my-agent -- --framework ai-sdk --hosts node,cloudflare,vercel --yes
```
