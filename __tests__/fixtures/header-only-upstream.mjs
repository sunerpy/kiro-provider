import { createServer } from "node:http";

let requests = 0;
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const server = createServer((request, response) => {
  request.resume();
  const index = ++requests;
  response.writeHead(200, { "Content-Type": "application/vnd.amazon.eventstream" });
  response.flushHeaders();
  report({ accepted: index });
  response.on("close", () => report({ closed: index }));
});
server.listen(0, "127.0.0.1", () => report({ port: server.address().port }));
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
