import { EventEmitter } from 'node:events';

/**
 * Fires whenever stored data changes, so open pages refetch over SSE. A topic
 * narrows what to refetch: 'files' is only the recent-files lists, which can
 * change many times a minute.
 */
export class ChangeFeed extends EventEmitter {
  notify(topic: 'all' | 'files' = 'all') {
    this.emit('change', topic);
  }
}
