import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceForTab, workspaceTab } from '../public/js/workspaces.js';

test('shared tools stay in the current workspace', () => {
  assert.equal(workspaceForTab('console', 'laser'), 'laser');
  assert.equal(workspaceForTab('console', 'configuration'), 'configuration');
  assert.equal(workspaceForTab('zones', 'laser'), 'laser');
});

test('opening a dedicated tool reveals its workspace, including legacy links', () => {
  assert.equal(workspaceForTab('laser', 'cnc'), 'laser');
  assert.equal(workspaceForTab('probe', 'laser'), 'cnc');
  assert.equal(workspaceForTab('settings', 'cnc'), 'configuration');
  assert.equal(workspaceForTab('macros', 'laser'), 'configuration');
});

test('workspace changes restore compatible tools and discard stale selections', () => {
  assert.equal(workspaceTab('cnc', 'probe'), 'probe');
  assert.equal(workspaceTab('laser', 'console'), 'console');
  assert.equal(workspaceTab('configuration', 'zones'), 'zones');
  assert.equal(workspaceTab('laser', 'probe'), 'laser');
  assert.equal(workspaceTab('configuration', null), 'settings');
  assert.equal(workspaceTab('cnc', 'removed'), 'console');
});

test('invalid stored workspace names fall back safely', () => {
  assert.equal(workspaceForTab('laser', '__proto__'), 'laser');
  assert.equal(workspaceForTab('removed', null), 'cnc');
  assert.equal(workspaceTab('constructor', 'console'), 'console');
});
