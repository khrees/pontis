const key = "sk-io6R8E7IJccEW6nohNK3KwmReHZEXq8SRBQnxJHSIbPHRFlBcuT0Qh9MEaNACLrM";
const url = "http://localhost:8787/zen/v1/messages";

async function makeTurn(messages, label) {
  const payload = {
    model: "claude-3-5-sonnet-20241022",
    messages: messages,
    system: "You are a senior system architect analyzing the provided codebase context.",
    stream: true,
    max_tokens: 1000
  };

  console.log(`\n--- ${label} ---`);
  console.log(`Sending request with payload size: ${(JSON.stringify(payload).length / 1024).toFixed(2)} KB...`);

  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": key,
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219"
    },
    body: JSON.stringify(payload)
  });

  console.log(`Response status: ${res.status} (took ${(performance.now() - start).toFixed(2)}ms)`);
  if (!res.ok) {
    console.error("Error response:", await res.text());
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let receivedFirstChunk = false;
  let firstChunkTime = 0;
  let chunkCount = 0;
  let assistantText = "";
  let thinkingText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkCount++;
    const chunkStr = decoder.decode(value, { stream: true });
    
    // Parse SSE chunk to gather text/thinking
    const lines = chunkStr.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.delta?.text) {
            assistantText += parsed.delta.text;
          }
          if (parsed.delta?.thinking) {
            thinkingText += parsed.delta.thinking;
          }
        } catch {}
      }
    }
    if (!receivedFirstChunk) {
      receivedFirstChunk = true;
      firstChunkTime = performance.now() - start;
      console.log(`Received first chunk in ${firstChunkTime.toFixed(2)}ms`);
    }
  }

  const totalTime = performance.now() - start;
  console.log(`Stream complete. Total chunks: ${chunkCount}, Total time: ${totalTime.toFixed(2)}ms`);
  console.log(`Thinking text snippet: "${thinkingText.slice(0, 80).replace(/\n/g, "\\n")}..."`);
  console.log(`Assistant text snippet: "${assistantText.slice(0, 80).replace(/\n/g, "\\n")}..."`);

  return { content: assistantText, thinking: thinkingText };
}

async function run() {
  // Build a large history: ~120KB of text
  const words = ["the", "quick", "brown", "fox", "jumps", "over", "the", "lazy", "dog", "code", "proxy", "pontis", "translation", "performance", "streaming"];
  let largeText = "";
  for (let i = 0; i < 20000; i++) {
    largeText += words[i % words.length] + " ";
  }

  const messages = [
    { role: "user", content: "Here is the codebase context:\n" + largeText },
  ];

  // Turn 1
  const result1 = await makeTurn(messages, "Turn 1 (Prefill Context)");
  if (!result1) return;

  // Append assistant message in Anthropic format to history
  messages.push({
    role: "assistant",
    content: [
      { type: "thinking", thinking: result1.thinking, signature: "sig" },
      { type: "text", text: result1.content }
    ]
  });
  
  // Append new user message for Turn 2
  messages.push({ role: "user", content: "Great. Now tell me what is the 5th word in the words list I gave you." });

  // Turn 2
  await makeTurn(messages, "Turn 2 (Appended Turn)");
}

run().catch(console.error);
