import { TinyAgent } from "tiny-agents";

export default new TinyAgent({ upper: (text: string) => text.toUpperCase(), mark: (text: string) => `${text}!` });
