import { EventEmitter } from 'node:events';

/** Fires whenever stored data changes, so open pages refetch over SSE. */
export class ChangeFeed extends EventEmitter {
  notify() {
    this.emit('change');
  }
}
