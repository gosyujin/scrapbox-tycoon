// A minimal in-memory model of GitHub's Git Data API (blobs/trees/commits +
// the branch ref), faithful enough to exercise GitHubStore/GitHubSyncStore
// for real: an artificial per-call delay stands in for real network
// latency, and the ref update enforces the same fast-forward-only rule
// GitHub itself applies (force:false rejects a commit whose parent isn't
// the current ref tip) -- that's what makes the optimistic-concurrency
// retry loop in github-store.ts's commit() actually meaningful to test.
//
// installMockGitHubApi() replaces global.fetch and global.localStorage
// (Node has neither) and returns a handle for inspecting/controlling it.
export function installMockGitHubApi({ delayMs = 100 } = {}) {
  const storage = new Map();
  global.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  let refSha = 'commit0';
  const commitTree = new Map([['commit0', 'tree0']]);
  const commitParent = new Map([['commit0', null]]);
  const treeFiles = new Map([['tree0', new Map()]]);
  const blobRegistry = new Map(); // blobId -> {treeSha, path} (avoids slashes in the synthetic sha)
  let idCounter = 1;

  // Resolves on the *next* POST git/trees -- unambiguous proof that
  // pushBatch()'s commit() is mid-flight (past its base-commit reads),
  // which is the fragile window a rapid second edit needs to land in to
  // exercise the race this mock exists to test. Call arm() fresh before
  // each sync under test; a stale already-resolved promise from an
  // earlier sync would make the wait a no-op.
  let resolveTreesPosted = () => {};
  function armTreesPostedSignal() {
    return new Promise((r) => {
      resolveTreesPosted = r;
    });
  }

  function delay() {
    return new Promise((r) => setTimeout(r, delayMs));
  }

  function json200(obj) {
    return new Response(JSON.stringify(obj), { status: 200 });
  }

  async function mockFetch(url, init) {
    await delay();
    const u = new URL(url);
    const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, '');
    const method = init?.method || 'GET';

    if (method === 'GET' && path === 'git/ref/heads/main') {
      return json200({ object: { sha: refSha } });
    }
    if (method === 'GET' && /^git\/commits\/[^/]+$/.test(path)) {
      const sha = path.split('/')[2];
      return json200({ tree: { sha: commitTree.get(sha) } });
    }
    if (method === 'GET' && /^git\/trees\/[^/]+$/.test(path)) {
      const treeSha = path.split('/')[2];
      const files = treeFiles.get(treeSha) || new Map();
      return json200({
        tree: [...files.keys()].map((p) => {
          const blobId = `blob${idCounter++}`;
          blobRegistry.set(blobId, { treeSha, path: p });
          return { path: p, type: 'blob', sha: blobId };
        }),
      });
    }
    if (method === 'GET' && /^git\/blobs\/[^/]+$/.test(path)) {
      const blobId = path.split('/')[2];
      const { treeSha, path: filePath } = blobRegistry.get(blobId) || {};
      const content = treeFiles.get(treeSha)?.get(filePath) ?? '';
      return json200({ content: Buffer.from(content, 'utf8').toString('base64') });
    }
    if (method === 'POST' && path === 'git/trees') {
      resolveTreesPosted();
      const body = JSON.parse(init.body);
      const base = new Map(treeFiles.get(body.base_tree) || []);
      for (const entry of body.tree) {
        if (entry.sha === null) base.delete(entry.path);
        else base.set(entry.path, entry.content);
      }
      const treeSha = `tree${idCounter++}`;
      treeFiles.set(treeSha, base);
      return json200({ sha: treeSha });
    }
    if (method === 'POST' && path === 'git/commits') {
      const body = JSON.parse(init.body);
      const commitSha = `commit${idCounter++}`;
      commitTree.set(commitSha, body.tree);
      commitParent.set(commitSha, body.parents[0]);
      return json200({ sha: commitSha });
    }
    if (method === 'PATCH' && path === 'git/refs/heads/main') {
      const body = JSON.parse(init.body);
      if (commitParent.get(body.sha) !== refSha) {
        return new Response(JSON.stringify({ message: 'not a fast forward' }), { status: 422 });
      }
      refSha = body.sha;
      return json200({ ok: true });
    }
    throw new Error(`mock GitHub API: unhandled ${method} ${path}`);
  }

  global.fetch = mockFetch;

  return {
    armTreesPostedSignal,
    currentRemoteState() {
      const files = treeFiles.get(commitTree.get(refSha));
      const index = files.get('pages/_index.json');
      return { index: index ? JSON.parse(index) : [], filePaths: [...files.keys()].sort() };
    },
  };
}
