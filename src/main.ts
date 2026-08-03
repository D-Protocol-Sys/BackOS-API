import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {

    const app = await NestFactory.create(AppModule);

    const configService = app.get(ConfigService);

    app.use(helmet());

    app.enableCors({

        origin: configService.get<string>(
            'CORS_ORIGIN',
            'http://localhost:9173'
        ),

        credentials: true,

    });

    app.useGlobalPipes(

        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
        }),
        
    );

    app.useGlobalFilters(new AllExceptionsFilter());

    app.setGlobalPrefix('api');

    const port = configService.get<number>('PORT', 4803);

    const swaggerConfig = new DocumentBuilder()
        .setTitle('BPG Core API')
        .setDescription('API du générateur BPG (Backend Platform Generator)')
        .setVersion('0.1.0')
        .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
        .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, swaggerDocument);

    await app.listen(port);

    Logger.log(`back-os Backend listening on ${port}`, 'Bootstrap');

}

bootstrap();
