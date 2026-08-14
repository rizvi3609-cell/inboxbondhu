export * from './types.js'
export { createMockMetaClient, type MockMetaState } from './__mocks__/client.js'
// The real HTTP client (client.ts) ships when a Meta app id/secret exist to
// test against; every consumer depends only on the MetaClient interface.
