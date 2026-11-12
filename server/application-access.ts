import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './domain/database.js';
import { createAppAccessService } from './domain/app-access.js';
import { administratorUsers, setAdministrator } from './domain/platform-access.js';
import type { IdentityHttp } from './identity.js';

export function registerApplicationAccess(app: FastifyInstance, db: Database, audience: string, identity: IdentityHttp) {
  const access = createAppAccessService(db, audience);
  const id = (params: unknown) => z.object({ id: z.string().uuid() }).strict().parse(params).id;
  const mutation = z.object({ requestId: z.string().uuid(), confirmed: z.literal(true) });
  const revision = mutation.extend({ revision: z.number().int().positive() });
  const user = async (request: Parameters<IdentityHttp['authenticate']>[0], write = false) => {
    if (write) identity.sameOrigin(request);
    return (await identity.authenticate(request)).id;
  };
  app.get('/api/access/candidates', async request => {
    const actorId = await user(request);
    const query = z.object({ appId: z.string().uuid().optional() }).strict().parse(request.query);
    return access.candidates(actorId, query.appId);
  });
  app.get('/api/access/governance', async request => ({ items: await access.governance(await user(request)) }));
  app.post('/api/access/apps/:id/adopt', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = mutation.extend({ ownerId: z.string().uuid(), expectedAppRevision: z.number().int().positive() }).strict().parse(request.body);
    return access.adopt(actorId, id(request.params), input);
  });
  app.get('/api/access/apps/:id', async request => access.settings(await user(request), id(request.params)));
  app.put('/api/access/apps/:id/sharing', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = revision.extend({ scope: z.enum(['all', 'members', 'groups', 'self']),
      memberIds: z.array(z.string().uuid()).max(500), groupIds: z.array(z.string().uuid()).max(500) }).strict().parse(request.body);
    return access.update(actorId, id(request.params), input);
  });
  app.put('/api/access/apps/:id/maintainers', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = revision.extend({ maintainerIds: z.array(z.string().uuid()).max(500) }).strict().parse(request.body);
    return access.update(actorId, id(request.params), input);
  });
  app.post('/api/access/apps/:id/transfers', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = revision.extend({ receiverId: z.string().uuid() }).strict().parse(request.body);
    return access.requestTransfer(actorId, id(request.params), input);
  });
  app.get('/api/access/transfers', async request => ({ items: await access.transfers(await user(request)) }));
  app.post('/api/access/transfers/:id', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = mutation.extend({ action: z.enum(['accept', 'decline', 'cancel']) }).strict().parse(request.body);
    return access.decideTransfer(actorId, id(request.params), input);
  });
  app.get('/api/access/administrators', async request => ({ items: await administratorUsers(db, await user(request)) }));
  app.put('/api/access/administrators', async request => {
    const actorId = await user(request, true);
    const { confirmed: _, ...input } = mutation.extend({ userId: z.string().uuid(), role: z.enum(['member', 'administrator', 'super_administrator']),
      revision: z.number().int().nonnegative() }).strict().parse(request.body);
    return setAdministrator(db, actorId, input);
  });
}
