// The app's own Durable Object, as a storage provider would ship one (Mastra's Cloudflare store does).
import { DurableObject } from "cloudflare:workers";

export class NoteStore extends DurableObject {
  async fetch(request: Request) {
    return new Response(`note store got ${new URL(request.url).pathname}`);
  }
}
