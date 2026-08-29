#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();
program
  .name("yar")
  .description("YarReader publication ingestion and portable reading")
  .version("1.0.0");

program.parse();
