import { createFileRoute } from "@tanstack/react-router";

const SITE_URL = "https://agentswarms.fyi";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () => {
        const body =
          `User-agent: *\n` +
          `Allow: /\n` +
          `Allow: /curriculum\n` +
          `Allow: /learn\n` +
          `Allow: /pricing\n` +
          `Allow: /about\n` +
          `Allow: /contact\n` +
          `Allow: /privacy\n` +
          `Disallow: /login\n` +
          `Disallow: /reset-password\n` +
          `Disallow: /verify\n` +
          `Disallow: /dashboard\n` +
          `Disallow: /agents\n` +
          `Disallow: /swarms\n` +
          `Disallow: /playground\n` +
          `Disallow: /patterns\n` +
          `Disallow: /knowledge\n` +
          `Disallow: /data-sql\n` +
          `Disallow: /traces\n` +
          `Disallow: /analytics\n` +
          `Disallow: /budgets\n` +
          `Disallow: /integrations\n` +
          `Disallow: /model-registry\n` +
          `Disallow: /mcp\n` +
          `Disallow: /account\n` +
          `Disallow: /templates\n` +
          `Disallow: /certification\n` +
          `Disallow: /admin\n` +
          `Disallow: /api/\n` +
          `Disallow: /email/\n` +
          `Disallow: /lovable/\n` +
          `\n` +
          `# ── Google ──\n` +
          `User-agent: Googlebot\n` +
          `Allow: /\n` +
          `User-agent: Google-Extended\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Bing / Microsoft Copilot ──\n` +
          `User-agent: Bingbot\n` +
          `Allow: /\n` +
          `User-agent: msnbot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── OpenAI ──\n` +
          `User-agent: GPTBot\n` +
          `Allow: /\n` +
          `User-agent: ChatGPT-User\n` +
          `Allow: /\n` +
          `User-agent: OAI-SearchBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Anthropic / Claude ──\n` +
          `User-agent: ClaudeBot\n` +
          `Allow: /\n` +
          `User-agent: anthropic-ai\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Perplexity ──\n` +
          `User-agent: PerplexityBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Meta ──\n` +
          `User-agent: Meta-ExternalAgent\n` +
          `Allow: /\n` +
          `User-agent: FacebookBot\n` +
          `Allow: /\n` +
          `User-agent: Facebookexternalhit\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Apple / Siri ──\n` +
          `User-agent: Applebot\n` +
          `Allow: /\n` +
          `User-agent: Applebot-Extended\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Amazon ──\n` +
          `User-agent: Amazonbot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── You.com ──\n` +
          `User-agent: YouBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Cohere ──\n` +
          `User-agent: cohere-ai\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Common Crawl (training data for many AI models) ──\n` +
          `User-agent: CCBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── DuckDuckGo ──\n` +
          `User-agent: DuckDuckBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Yandex ──\n` +
          `User-agent: YandexBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Baidu ──\n` +
          `User-agent: Baiduspider\n` +
          `Allow: /\n` +
          `\n` +
          `# ── ByteDance / TikTok ──\n` +
          `User-agent: Bytespider\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Brave Search ──\n` +
          `User-agent: BraveBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Mistral ──\n` +
          `User-agent: MistralBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── X / Grok ──\n` +
          `User-agent: Twitterbot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── LinkedIn ──\n` +
          `User-agent: LinkedInBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── Telegram ──\n` +
          `User-agent: TelegramBot\n` +
          `Allow: /\n` +
          `\n` +
          `# ── WhatsApp / Slack / Discord link previews ──\n` +
          `User-agent: WhatsApp\n` +
          `Allow: /\n` +
          `User-agent: Slackbot\n` +
          `Allow: /\n` +
          `User-agent: Discordbot\n` +
          `Allow: /\n` +
          `\n` +
          `Sitemap: ${SITE_URL}/sitemap.xml\n` +
          `Host: ${SITE_URL.replace(/^https?:\/\//, "")}\n`;

        return new Response(body, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
