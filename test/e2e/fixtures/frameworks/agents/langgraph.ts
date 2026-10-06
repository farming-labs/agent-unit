import { AIMessage } from "@langchain/core/messages";
import { END, interrupt, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { countEffect } from "../lib/effects";

export default new StateGraph(MessagesAnnotation)
  .addNode("plan", async () => {
    await countEffect("plan:langgraph");
    return { messages: [new AIMessage("I will refund o_42.")] };
  })
  .addNode("review", () => {
    const decision = interrupt<{ orderId: string }, { approved: boolean }>({ orderId: "o_42" });
    return { messages: [new AIMessage(decision.approved ? "approved" : "declined")] };
  })
  .addNode("refund", async () => {
    await countEffect("refund:langgraph");
    return { messages: [new AIMessage("Refunded o_42.")] };
  })
  .addEdge(START, "plan")
  .addEdge("plan", "review")
  .addEdge("review", "refund")
  .addEdge("refund", END)
  .compile();
