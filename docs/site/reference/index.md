# Reference

The pages in this section are the contracts the code is held to. The guide pages explain how to do something; these
say exactly what is accepted, what is refused and why.

| Page                                                      | Covers                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Command line](cli.md)                                    | Every command and option of `kiro-provider`.                                            |
| [Configuration](../../CONFIGURATION.md)                   | Every field of `config.json`, its environment variable, default and limits.             |
| [Protocol compatibility](../../PROTOCOL_COMPATIBILITY.md) | The routes, the two Responses paths, and which request fields each API accepts.         |
| [Usage and context](../../RESPONSES_USAGE.md)             | How token usage is reported, and why a client's context gauge differs from consumption. |
| [Streaming errors](../../STREAM_ERROR_CONTRACT.md)        | What a client receives when a stream fails after it has started. English only.          |
| [Historical tool calls](../../HISTORICAL_TOOLS.md)        | Why a tool call in the history is not permission to call that tool now. English only.   |
| [Frequently asked questions](faq.md)                      | Short answers, with links to the page that has the detail.                              |
| [Data and network](../privacy.md)                         | Every file kiro-provider writes and every host it talks to.                             |

The dated evidence behind these contracts, probes, client validations and reviews, is kept in the repository's
[audit index](../../audits/README.md).
