// import { Test } from '@nestjs/testing';
// import { INestApplication, ValidationPipe } from '@nestjs/common';
// import { ThrottlerGuard } from '@nestjs/throttler';
// import { AppModule } from '../../src/app.module';
// import { PrismaService } from '../../src/prisma/prisma.service';
// import { EmailService } from '../../src/email/email.service';
// import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
// import { FakeEmailService } from './fake-email.service';
// import { resetDatabase } from './reset-database.util';

// export interface TestContext {
//     app: INestApplication;
//     prisma: PrismaService;
//     fakeEmail: FakeEmailService;
// }

// export async function createTestApp(): Promise<TestContext> {
//     const moduleRef = await Test.createTestingModule({
//         imports: [AppModule],
//     })
//         .overrideProvider(EmailService)
//         .useClass(FakeEmailService)
//         // Le rate limiting fausserait des tests qui enchaînent volontairement
//         // plusieurs requêtes OTP pour vérifier différents scénarios.
//         .overrideGuard(ThrottlerGuard)
//         .useValue({ canActivate: () => true })
//         .compile();

//     const app = moduleRef.createNestApplication();
//     app.useGlobalPipes(
//         new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
//     );
//     app.useGlobalFilters(new AllExceptionsFilter());
//     app.setGlobalPrefix('api');
//     await app.init();

//     const prisma = app.get(PrismaService);
//     const fakeEmail = app.get(EmailService) as unknown as FakeEmailService;

//     await resetDatabase(prisma);

//     return { app, prisma, fakeEmail };
// }

// export async function closeTestApp(ctx: TestContext): Promise<void> {
//     await ctx.app.close();
// }