#!/usr/bin/env node
import { createCLI } from './cli-lib';

const cli = createCLI();
cli.parse();
