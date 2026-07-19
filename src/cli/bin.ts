#!/usr/bin/env bun
import { main } from "./main.js";

process.exitCode = await main();
