// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_INFO } from '../src/build-info.js';
import { VERSION } from '../src/commands.js';

test('development version comes from package and command uses build info', () => {
  assert.match(BUILD_INFO.version, /^\d+\.\d+\.\d+$/);
  assert.equal(VERSION, BUILD_INFO.version);
});
