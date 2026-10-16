export function buildOtpEmail(code: string, firstName: string) {
    const subject = 'Votre code de connexion • Back OS';

    const text = `
Bonjour ${firstName},

Vous avez demandé un code de connexion pour accéder à votre compte Back OS.

Votre code de vérification est :

${code}

Ce code est valable pendant 10 minutes.

Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.

—
Back OS
`;

    const html = `
<!DOCTYPE html>
<html lang="fr">

<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>

<body style="
    margin:0;
    padding:40px 20px;
    background:#f4f6f8;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    color:#1f2937;
">

<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
<tr>
<td align="center">

<table
    role="presentation"
    cellpadding="0"
    cellspacing="0"
    width="100%"
    style="
        max-width:560px;
        background:#ffffff;
        border-radius:16px;
        overflow:hidden;
        box-shadow:0 10px 35px rgba(0,0,0,.08);
    "
>

<tr>
<td
    style="
        background:#111827;
        padding:32px;
        text-align:center;
    "
>

<h1 style="
    margin:0;
    color:#ffffff;
    font-size:28px;
    font-weight:700;
">
Back OS
</h1>

<p style="
    margin-top:8px;
    color:#d1d5db;
    font-size:15px;
">
Connexion sécurisée
</p>

</td>
</tr>

<tr>
<td style="padding:40px;">

<p style="
    margin:0 0 16px;
    font-size:18px;
    font-weight:600;
">
Bonjour ${firstName},
</p>

<p style="
    margin:0;
    line-height:1.7;
    color:#4b5563;
">
Nous avons reçu une demande de connexion à votre compte.
Utilisez le code ci-dessous pour poursuivre.
</p>

<div
    style="
        margin:36px 0;
        padding:24px;
        border:1px solid #e5e7eb;
        border-radius:12px;
        background:#f9fafb;
        text-align:center;
    "
>

<p style="
    margin:0 0 12px;
    color:#6b7280;
    font-size:13px;
    text-transform:uppercase;
    letter-spacing:1px;
">
Code de vérification
</p>

<p style="
    margin:0;
    font-size:42px;
    font-weight:700;
    letter-spacing:10px;
    color:#111827;
">
${code}
</p>

</div>

<p style="
    margin:0;
    color:#4b5563;
    line-height:1.7;
">
Ce code est valable pendant
<strong>10 minutes</strong>.
</p>

<p style="
    margin-top:24px;
    color:#6b7280;
    line-height:1.7;
">
Si vous n'êtes pas à l'origine de cette demande,
vous pouvez simplement ignorer cet e-mail.
Aucune action supplémentaire n'est nécessaire.
</p>

</td>
</tr>

<tr>
<td
    style="
        padding:24px 40px;
        border-top:1px solid #e5e7eb;
        background:#fafafa;
    "
>

<p style="
    margin:0;
    font-size:13px;
    color:#9ca3af;
    line-height:1.7;
">

Cet e-mail a été envoyé automatiquement par
<strong>Back OS</strong>.

<br><br>

Merci de ne pas répondre à ce message.

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
