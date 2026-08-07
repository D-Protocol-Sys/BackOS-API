/**
 * Generates both HTML and Plain Text email payloads for account activation invitations.
 *
 * @param activationLink - Complete URL targeting the frontend activation page with the token.
 * @param code - Plain text 6-digit verification code.
 * @param firstName - Target user's first name.
 * @param username - Unique username assigned to the user.
 * @param workEmail - Professional work email associated with the account.
 * @param expiresInHours - Expiration delay in hours.
 * @returns Object containing the email subject, plain text body, and HTML body.
 */
export function buildInvitationEmail(
    activationLink: string, 
    code: string, 
    firstName: string, 
    username: string,
    workEmail: string,
    expiresInHours: number,
) {
    const cleanFirstName = firstName.trim();
    const cleanUsername = username.trim();
    const cleanWorkEmail = workEmail.trim();
    const cleanCode = code.trim();

    const subject = 'Bienvenue sur Back OS • Activez votre compte';

    // ---- Plain Text Fallback ----
    const text = `
        Bonjour ${cleanFirstName},

        Un compte a été créé pour vous sur la plateforme Back OS.

        Vos identifiants d'accès :
        - Nom d'utilisateur : ${cleanUsername}
        - Adresse e-mail professionnelle : ${cleanWorkEmail}
        - Code de validation : ${cleanCode}

        Pour activer votre compte et définir votre mot de passe, visitez le lien suivant :
        ${activationLink}

        ⚠️ Ce lien et ce code sont valables pendant ${expiresInHours} heures.

        Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail.

        —
        L'équipe Back OS
    `;

    // ---- Modern & Elegant HTML Template ----
    const html = `
        <!DOCTYPE html>
        <html lang="fr" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <meta name="x-apple-disable-message-reformatting" />
                <title>${subject}</title>
            </head>

            <body style="
                margin: 0;
                padding: 40px 16px;
                background-color: #f1f5f9;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                color: #334155;
                -webkit-font-smoothing: antialiased;
                -webkit-text-size-adjust: 100%;
            ">

                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse: collapse;">
                    <tr>
                        <td align="center">

                            <table
                                role="presentation"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                                style="
                                    max-width: 520px;
                                    background-color: #ffffff;
                                    border-radius: 16px;
                                    overflow: hidden;
                                    border: 1px solid #e2e8f0;
                                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
                                    border-collapse: separate;
                                "
                            >

                                <tr>
                                    <td style="
                                        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
                                        padding: 36px 32px;
                                        text-align: center;
                                    ">
                                        <div style="
                                            display: inline-block;
                                            padding: 8px 16px;
                                            background-color: rgba(255, 255, 255, 0.08);
                                            border: 1px solid rgba(255, 255, 255, 0.12);
                                            border-radius: 20px;
                                            margin-bottom: 12px;
                                        ">
                                            <span style="
                                                color: #38bdf8;
                                                font-size: 12px;
                                                font-weight: 600;
                                                letter-spacing: 1.5px;
                                                text-transform: uppercase;
                                            ">
                                                Activation du compte
                                            </span>
                                        </div>

                                        <h1 style="
                                            margin: 0;
                                            color: #ffffff;
                                            font-size: 28px;
                                            font-weight: 800;
                                            letter-spacing: -0.5px;
                                        ">
                                            Back OS
                                        </h1>
                                    </td>
                                </tr>

                                <tr>
                                    <td style="padding: 40px 32px;">

                                        <p style="
                                            margin: 0 0 16px 0;
                                            font-size: 20px;
                                            font-weight: 700;
                                            color: #0f172a;
                                            letter-spacing: -0.3px;
                                        ">
                                            Bonjour ${cleanFirstName}, 👋
                                        </p>

                                        <p style="
                                            margin: 0 0 24px 0;
                                            line-height: 1.6;
                                            color: #475569;
                                            font-size: 15px;
                                        ">
                                            Un compte vient d'être créé pour vous sur la plateforme <strong>Back OS</strong>. Pour finaliser votre inscription et définir votre mot de passe, veuillez suivre les étapes ci-dessous.
                                        </p>

                                        <div style="
                                            margin: 0 0 28px 0;
                                            padding: 18px 20px;
                                            background-color: #f8fafc;
                                            border: 1px solid #e2e8f0;
                                            border-radius: 12px;
                                        ">
                                            <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                                                <tr>
                                                    <td style="font-size: 13px; color: #64748b; font-weight: 500; padding-bottom: 8px;">
                                                        Nom d'utilisateur :
                                                    </td>
                                                    <td align="right" style="
                                                        font-size: 14px;
                                                        color: #0f172a;
                                                        font-weight: 700;
                                                        font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
                                                        padding-bottom: 8px;
                                                    ">
                                                        @${cleanUsername}
                                                    </td>
                                                </tr>
                                                <tr>
                                                    <td style="font-size: 13px; color: #64748b; font-weight: 500; border-top: 1px dashed #e2e8f0; padding-top: 8px;">
                                                        E-mail professionnel :
                                                    </td>
                                                    <td align="right" style="
                                                        font-size: 14px;
                                                        color: #0f172a;
                                                        font-weight: 600;
                                                        border-top: 1px dashed #e2e8f0;
                                                        padding-top: 8px;
                                                    ">
                                                        ${cleanWorkEmail}
                                                    </td>
                                                </tr>
                                            </table>
                                        </div>

                                        <div style="text-align: center; margin: 32px 0;">
                                            <a href="${activationLink}" target="_blank" style="
                                                display: inline-block;
                                                background-color: #2563eb;
                                                color: #ffffff;
                                                text-decoration: none;
                                                padding: 14px 32px;
                                                border-radius: 10px;
                                                font-weight: 600;
                                                font-size: 15px;
                                                box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
                                            ">
                                                Activer mon compte &rarr;
                                            </a>
                                        </div>

                                        <div style="
                                            margin: 28px 0;
                                            padding: 24px 20px;
                                            border: 1px dashed #cbd5e1;
                                            border-radius: 12px;
                                            background-color: #ffffff;
                                            text-align: center;
                                        ">
                                            <p style="
                                                margin: 0 0 8px 0;
                                                color: #64748b;
                                                font-size: 11px;
                                                font-weight: 700;
                                                text-transform: uppercase;
                                                letter-spacing: 1.2px;
                                            ">
                                                Code de sécurité requis
                                            </p>

                                            <p style="
                                                margin: 0;
                                                font-family: ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
                                                font-size: 32px;
                                                font-weight: 800;
                                                letter-spacing: 10px;
                                                padding-left: 10px;
                                                color: #0f172a;
                                            ">
                                                ${cleanCode}
                                            </p>
                                        </div>

                                        <p style="
                                            margin: 24px 0 0 0;
                                            color: #64748b;
                                            font-size: 13px;
                                            line-height: 1.5;
                                            text-align: center;
                                        ">
                                            ⏱️ Ce lien et ce code sont à usage unique et expireront dans <strong>${expiresInHours} heures</strong>.
                                        </p>

                                    </td>
                                </tr>

                                <tr>
                                    <td style="padding: 0 32px;">
                                        <div style="height: 1px; background-color: #f1f5f9; width: 100%;"></div>
                                    </td>
                                </tr>

                                <tr>
                                    <td style="
                                        padding: 28px 32px;
                                        background-color: #ffffff;
                                        text-align: center;
                                    ">
                                        <p style="
                                            margin: 0 0 8px 0;
                                            font-size: 12px;
                                            color: #94a3b8;
                                            line-height: 1.5;
                                        ">
                                            Si vous n'êtes pas le destinataire de cette invitation, vous pouvez ignorer cet e-mail en toute sécurité.
                                        </p>

                                        <p style="
                                            margin: 0;
                                            font-size: 12px;
                                            color: #cbd5e1;
                                        ">
                                            &copy; Back OS &bull; Message envoyé automatiquement, merci de ne pas y répondre.
                                        </p>
                                    </td>
                                </tr>

                            </table>

                        </td>
                    </tr>
                </table>

            </body>
        </html>
    `;

    return {
        subject,
        text,
        html,
    };
}