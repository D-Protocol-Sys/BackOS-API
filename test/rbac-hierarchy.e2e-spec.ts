// import * as request from 'supertest';
// import { createTestApp, closeTestApp, TestContext } from './utils/test-app.factory';

// async function registerAndLogin(ctx: TestContext, email: string, firstName: string) {
//     await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email, firstName, lastName: 'Test' });
//     const code = ctx.fakeEmail.getLastOtpCodeFor(email);
//     const { body } = await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/verify')
//         .send({ email, code });
//     return body.accessToken as string;
// }

// describe('RBAC hiérarchie (e2e)', () => {
//     let ctx: TestContext;
//     let ownerToken: string;

//     beforeAll(async () => {
//         ctx = await createTestApp();
//         ownerToken = await registerAndLogin(ctx, 'owner@test.com', 'Owner'); // 1er user -> owner
//     });

//     afterAll(async () => {
//         await closeTestApp(ctx);
//     });

//     it('le owner peut modifier son propre profil (non-régression : ne doit jamais être bloqué)', async () => {
//         const me = await request(ctx.app.getHttpServer())
//         .get('/api/users/me')
//         .set('Authorization', `Bearer ${ownerToken}`);

//         await request(ctx.app.getHttpServer())
//         .patch(`/api/users/${me.body.id}`)
//         .set('Authorization', `Bearer ${ownerToken}`)
//         .send({ firstName: 'OwnerModifié' })
//         .expect(200);
//     });

//     it('le owner ne peut pas se désactiver lui-même en tant que dernier owner', async () => {
//         const me = await request(ctx.app.getHttpServer())
//         .get('/api/users/me')
//         .set('Authorization', `Bearer ${ownerToken}`);

//         await request(ctx.app.getHttpServer())
//         .patch(`/api/users/${me.body.id}/deactivate`)
//         .set('Authorization', `Bearer ${ownerToken}`)
//         .expect(403);
//     });

//     it("un admin ne peut pas désactiver un autre admin (rang égal)", async () => {
//         const roles = await request(ctx.app.getHttpServer())
//         .get('/api/roles')
//         .set('Authorization', `Bearer ${ownerToken}`);
//         const adminRole = roles.body.find((r: any) => r.name === 'admin');

//         const admin1Token = await registerAndLogin(ctx, 'admin1@test.com', 'Admin1');
//         const admin1 = await request(ctx.app.getHttpServer())
//         .get('/api/users/me')
//         .set('Authorization', `Bearer ${admin1Token}`);
//         await request(ctx.app.getHttpServer())
//         .post(`/api/users/${admin1.body.id}/roles`)
//         .set('Authorization', `Bearer ${ownerToken}`)
//         .send({ roleId: adminRole.id })
//         .expect(201);

//         const admin2Token = await registerAndLogin(ctx, 'admin2@test.com', 'Admin2');
//         const admin2 = await request(ctx.app.getHttpServer())
//         .get('/api/users/me')
//         .set('Authorization', `Bearer ${admin2Token}`);
//         await request(ctx.app.getHttpServer())
//         .post(`/api/users/${admin2.body.id}/roles`)
//         .set('Authorization', `Bearer ${ownerToken}`)
//         .send({ roleId: adminRole.id })
//         .expect(201);

//         // se reconnecter pour obtenir un token avec les permissions à jour
//         const admin1FreshToken = await registerAndLogin(ctx, 'admin1@test.com', 'Admin1');

//         await request(ctx.app.getHttpServer())
//         .patch(`/api/users/${admin2.body.id}/deactivate`)
//         .set('Authorization', `Bearer ${admin1FreshToken}`)
//         .expect(403);
//     });

//     it('un admin ne peut pas créer un rôle custom de rang égal ou supérieur au sien', async () => {
//         const admin1Token = await registerAndLogin(ctx, 'admin1@test.com', 'Admin1');

//         await request(ctx.app.getHttpServer())
//         .post('/api/roles')
//         .set('Authorization', `Bearer ${admin1Token}`)
//         .send({ name: 'faux-owner', level: 0, permissionKeys: [] })
//         .expect(403);
//     });
// });