// import * as request from 'supertest';
// import { createTestApp, closeTestApp, TestContext } from './utils/test-app.factory';
// import { afterEach, describe } from 'node:test';

// describe('Auth (e2e)', () => {
    
//     let ctx: TestContext;

//     beforeAll(async () => {
//         ctx = await createTestApp();
//     });

//     afterAll(async () => {
//         await closeTestApp(ctx);
//     });

//     afterEach(() => {
//         ctx.fakeEmail.reset();
//     });

//     it('POST /auth/otp/request crée le user et envoie un code', async () => {
//         const response = await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'alice@test.com', firstName: 'Alice', lastName: 'Test' })
//         .expect(201);

//         expect(response.body.message).toBeDefined();
//         expect(ctx.fakeEmail.sentEmails).toHaveLength(1);
//         expect(ctx.fakeEmail.sentEmails[0].to).toBe('alice@test.com');
//     });

//     it('le premier utilisateur du système devient automatiquement owner', async () => {
//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'bob@test.com', firstName: 'Bob', lastName: 'Test' })
//         .expect(201);

//         const code = ctx.fakeEmail.getLastOtpCodeFor('bob@test.com');

//         const verifyResponse = await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/verify')
//         .send({ email: 'bob@test.com', code })
//         .expect(200);

//         expect(verifyResponse.body.accessToken).toBeDefined();
//         expect(verifyResponse.body.refreshToken).toBeDefined();

//         const meResponse = await request(ctx.app.getHttpServer())
//         .get('/api/users/me')
//         .set('Authorization', `Bearer ${verifyResponse.body.accessToken}`)
//         .expect(200);

//         const roleNames = meResponse.body.userRoles.map((ur: any) => ur.role.name);
//         expect(roleNames).toContain('owner');
//     });

//     it('rejette un code invalide', async () => {
//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'carla@test.com', firstName: 'Carla', lastName: 'Test' })
//         .expect(201);

//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/verify')
//         .send({ email: 'carla@test.com', code: '000000' })
//         .expect(401);
//     });

//     it('rejette une deuxième demande OTP trop rapprochée (anti-spam)', async () => {
//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'dan@test.com', firstName: 'Dan', lastName: 'Test' })
//         .expect(201);

//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'dan@test.com', firstName: 'Dan', lastName: 'Test' })
//         .expect(400);
//     });

//     it('refresh token : rotation, ancien token révoqué après usage', async () => {
//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/request')
//         .send({ email: 'eve@test.com', firstName: 'Eve', lastName: 'Test' });
//         const code = ctx.fakeEmail.getLastOtpCodeFor('eve@test.com');
//         const { body } = await request(ctx.app.getHttpServer())
//         .post('/api/auth/otp/verify')
//         .send({ email: 'eve@test.com', code });

//         const refreshed = await request(ctx.app.getHttpServer())
//         .post('/api/auth/refresh')
//         .send({ refreshToken: body.refreshToken })
//         .expect(201);

//         expect(refreshed.body.accessToken).toBeDefined();

//         // rejouer l'ancien refresh token doit échouer (déjà révoqué)
//         await request(ctx.app.getHttpServer())
//         .post('/api/auth/refresh')
//         .send({ refreshToken: body.refreshToken })
//         .expect(401);
//     });

//     it('GET /users/me sans token -> 401', async () => {
//         await request(ctx.app.getHttpServer()).get('/api/users/me').expect(401);
//     });
// });