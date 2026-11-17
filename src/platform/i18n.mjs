/**
 * UFR-030 language support (Spanish) for the demonstration's forms and
 * claimant flows. A request-scoped language (cookie `ufr_lang`, else
 * Accept-Language) selects a catalog that translates the static UI text of
 * rendered claimant pages at the text-node and accessible-attribute level.
 * Data never changes: form field names and values, codes, hashes, dates,
 * user-entered text and signed receipt JSON stay byte-identical (a signed
 * receipt is canonical English JSON; only its on-screen labels are
 * translated). Staff pages remain English.
 */
const ES = {
  // chrome
  "Skip to main content": "Saltar al contenido principal", "Main navigation": "Navegación principal", "Footer navigation": "Navegación del pie de página",
  "Demonstration notice": "Aviso de demostración", "Development prototype · demonstration only": "Prototipo en desarrollo · solo demostración",
  "Not an official U.S. Government filing service. Demonstration only: use synthetic data. Receipts from this site are not government receipts and preserve no legal deadline.":
    "No es un servicio oficial de presentación del Gobierno de los Estados Unidos. Solo demostración: use datos ficticios. Los acuses de este sitio no son acuses del gobierno y no preservan ningún plazo legal.",
  "Federal Filing": "Presentación federal", "Demonstration prototype": "Prototipo de demostración", "Federal Filing Prototype home": "Inicio del prototipo de presentación federal",
  "Federal Filing Prototype": "Prototipo de presentación federal", "Overview": "Inicio", "File (demo)": "Presentar (demo)", "Track": "Seguimiento",
  "Verify a receipt": "Verificar un acuse", "Agency directory": "Directorio de agencias", "Transparency": "Transparencia", "Assistance": "Asistencia",
  "English": "English", "Privacy": "Privacidad", "Help &amp; safety": "Ayuda y seguridad", "Project boundaries": "Límites del proyecto",
  "Demonstration only. Fictional agencies, synthetic data, no filing authority, no government receipt.":
    "Solo demostración. Agencias ficticias, datos ficticios, sin autoridad de presentación, sin acuse del gobierno.",
  "There is a problem": "Hay un problema",
  // filing form
  "Demonstration filing": "Presentación de demostración", "Submit a demonstration filing": "Enviar una presentación de demostración",
  "Practice the filing journey with fictional agencies. You will receive a signed demonstration receipt, a tracking number and a one-time access code.":
    "Practique el proceso con agencias ficticias. Recibirá un acuse de demostración firmado, un número de seguimiento y un código de acceso de un solo uso.",
  "Not sure what to file? Use the guide.": "¿No sabe qué presentar? Use la guía.", "Resume a saved draft.": "Retomar un borrador guardado.",
  "Fictional recipient agency": "Agencia destinataria ficticia", "Filing type": "Tipo de presentación", "Subject": "Asunto", "Filing text": "Texto de la presentación",
  "Your name (synthetic; stored encrypted)": "Su nombre (ficticio; se guarda cifrado)", "Contact (optional, synthetic; stored encrypted)": "Contacto (opcional, ficticio; se guarda cifrado)",
  "Attachments (optional: up to 3 PDF, text, PNG or JPEG files; 5 MB each). Files are scanned; anything unsafe is quarantined.":
    "Adjuntos (opcional: hasta 3 archivos PDF, de texto, PNG o JPEG; 5 MB cada uno). Los archivos se analizan; lo que no sea seguro queda en cuarentena.",
  "Urgency": "Urgencia", "This matter involves an imminent risk to health, safety, shelter or liberty (prioritized routing, 4-hour target).":
    "Este asunto implica un riesgo inminente para la salud, la seguridad, la vivienda o la libertad (envío prioritario, objetivo de 4 horas).",
  "Before you submit (required)": "Antes de enviar (obligatorio)",
  "I understand this is a demonstration that files nothing with any government institution.": "Entiendo que esto es una demostración que no presenta nada ante ninguna institución del gobierno.",
  "I am entering only synthetic, made-up information. No real personal data.": "Solo estoy ingresando información ficticia e inventada. Ningún dato personal real.",
  "This contains no classified or sensitive government information.": "Esto no contiene información clasificada ni información gubernamental sensible.",
  "Submit demonstration filing": "Enviar presentación de demostración", "Save draft (text only)": "Guardar borrador (solo texto)",
  "Agency:": "Agencia:", "Not specified": "Sin especificar", "yes": "sí", "no": "no", "other": "otro",
  // filing types and agencies (display only)
  "administrative-claim": "reclamación administrativa", "administrative-appeal": "apelación administrativa", "records-request": "solicitud de registros",
  "records-appeal": "apelación de registros", "tort-claim-notice": "aviso de reclamación por daños", "complaint": "queja", "petition": "petición",
  "general-correspondence": "correspondencia general",
  "Demonstration Benefits Claims Office (fictional)": "Oficina de Reclamaciones de Beneficios de demostración (ficticia)",
  "Demonstration Records Access Unit (fictional)": "Unidad de Acceso a Registros de demostración (ficticia)",
  "Demonstration Tort Claims Desk (fictional)": "Mesa de Reclamaciones por Daños de demostración (ficticia)",
  "Demonstration Civil Rights Intake Desk (fictional)": "Mesa de Recepción de Derechos Civiles de demostración (ficticia)",
  // guide and structured fields
  "Guided filing": "Presentación guiada", "What do you need to do?": "¿Qué necesita hacer?",
  "Choose the closest description. You will get a form with the details that kind of filing usually needs. Fictional agencies only; this is not legal advice.":
    "Elija la descripción más cercana. Recibirá un formulario con los datos que suele requerir ese tipo de presentación. Solo agencias ficticias; esto no es asesoría legal.",
  "Ask an agency to pay or provide a benefit": "Pedir a una agencia que pague o conceda un beneficio", "Benefit, payment or reimbursement requests.": "Solicitudes de beneficios, pagos o reembolsos.",
  "Appeal an agency decision": "Apelar una decisión de una agencia", "You received a decision and want it reviewed.": "Recibió una decisión y quiere que se revise.",
  "Request government records": "Solicitar registros del gobierno", "Records-access (FOIA-style) requests.": "Solicitudes de acceso a registros (tipo FOIA).",
  "Appeal a records-request response": "Apelar la respuesta a una solicitud de registros", "Withholding, fees, search adequacy or delay.": "Retención, tarifas, búsqueda insuficiente o demora.",
  "Claim for damage or injury caused by an agency": "Reclamación por daños o lesiones causados por una agencia",
  "Property damage or personal injury; a sum certain is required.": "Daños a la propiedad o lesiones personales; se requiere una suma determinada.",
  "Complain about conduct or treatment": "Quejarse de una conducta o un trato", "Civil-rights or service complaints.": "Quejas de derechos civiles o de servicio.",
  "Petition an agency to act": "Pedir a una agencia que actúe", "Ask for a rule, policy or action.": "Pedir una norma, política o acción.",
  "Something else": "Otra cosa", "General correspondence to a fictional agency.": "Correspondencia general a una agencia ficticia.",
  "Claim category": "Categoría de la reclamación", "Amount claimed (USD, if any)": "Monto reclamado (USD, si corresponde)",
  "Date of the event giving rise to the claim": "Fecha del hecho que origina la reclamación", "Decision or case reference": "Referencia de la decisión o del caso",
  "Date of the decision": "Fecha de la decisión", "Relief sought": "Reparación solicitada", "Describe the records": "Describa los registros",
  "Records from": "Registros desde", "Records to": "Registros hasta", "Fee waiver requested": "Exención de tarifas solicitada",
  "Expedited processing requested": "Tramitación acelerada solicitada", "Original request tracking number": "Número de seguimiento de la solicitud original",
  "Date of the response": "Fecha de la respuesta", "Basis of appeal": "Motivo de la apelación", "Date of incident": "Fecha del incidente",
  "Location of incident": "Lugar del incidente", "Type of claim": "Tipo de reclamación", "Sum certain claimed (USD)": "Suma determinada reclamada (USD)",
  "What is the complaint about?": "¿Sobre qué es la queja?", "Action requested": "Acción solicitada",
  "benefit": "beneficio", "payment": "pago", "reimbursement": "reembolso", "withholding": "retención", "adequacy of search": "búsqueda insuficiente",
  "fees": "tarifas", "delay": "demora", "property": "propiedad", "personal injury": "lesiones personales", "both": "ambos",
  // drafts
  "Draft saved": "Borrador guardado", "Your draft is saved for 7 days": "Su borrador se guarda durante 7 días", "Draft code:": "Código del borrador:",
  "Shown once. Attachments and confirmations are not saved; add them when you resume. Nothing has been filed.":
    "Se muestra una sola vez. Los adjuntos y las confirmaciones no se guardan; agréguelos al retomarlo. No se ha presentado nada.",
  "Resume a draft →": "Retomar un borrador →", "Drafts": "Borradores", "Resume a saved draft": "Retomar un borrador guardado", "Draft code": "Código del borrador",
  "Resume": "Retomar",
  // classified refusal
  "Submission stopped": "Envío detenido", "Classification markings detected": "Se detectaron marcas de clasificación",
  "Your submission appears to contain U.S. classification markings. It was": "Su envío parece contener marcas de clasificación de los Estados Unidos.",
  "not saved": "No se guardó", "; only a content-free audit event was recorded.": "; solo se registró un evento de auditoría sin contenido.",
  "Classified information must never be sent through an unclassified website. Contact your security officer or the responsible institution for an authorized classified channel.":
    "La información clasificada nunca debe enviarse por un sitio web no clasificado. Comuníquese con su oficial de seguridad o con la institución responsable para obtener un canal clasificado autorizado.",
  "Read help and safety guidance →": "Leer la guía de ayuda y seguridad →",
  // receipt
  "Demonstration filing received": "Presentación de demostración recibida", "Your demonstration filing was received": "Se recibió su presentación de demostración",
  "This filing was already received": "Esta presentación ya se había recibido", "Save these now": "Guarde estos datos ahora", "Tracking number:": "Número de seguimiento:",
  "Access code:": "Código de acceso:",
  "The access code is shown only once and is stored only as a salted hash. You need both to check status or add a supplement. A tracking number alone grants no access.":
    "El código de acceso se muestra una sola vez y solo se guarda como un hash con sal. Necesita ambos para consultar el estado o agregar un complemento. El número de seguimiento por sí solo no da acceso.",
  "This repeat submission returned the original receipt. Use the access code shown when you first submitted.":
    "Este envío repetido devolvió el acuse original. Use el código de acceso que se mostró la primera vez.",
  "Demonstration receipt": "Acuse de demostración", "DEMONSTRATION RECEIPT · NOT A GOVERNMENT RECEIPT": "ACUSE DE DEMOSTRACIÓN · NO ES UN ACUSE DEL GOBIERNO",
  "Receipt ID": "ID del acuse", "Tracking number": "Número de seguimiento", "Kind": "Tipo", "original": "original", "amendment": "complemento",
  "Received (database time of record)": "Recibido (hora oficial de la base de datos)", "Fictional recipient": "Destinatario ficticio",
  "Content manifest SHA-256": "SHA-256 del manifiesto de contenido", "Ledger entry": "Entrada del registro", "Signing key": "Clave de firma",
  "DEMONSTRATION RECEIPT issued by a development prototype. Not issued by or on behalf of the United States Government and not evidence that any government institution received a filing. Synthetic data only.":
    "ACUSE DE DEMOSTRACIÓN emitido por un prototipo en desarrollo. No lo emite el Gobierno de los Estados Unidos ni se emite en su nombre, y no prueba que ninguna institución del gobierno haya recibido una presentación. Solo datos ficticios.",
  "Signed receipt JSON (paste into the verifier)": "JSON del acuse firmado (péguelo en el verificador)", "Check status →": "Consultar el estado →",
  "Verify a receipt →": "Verificar un acuse →",
  // tracking
  "Track a filing": "Seguimiento de una presentación", "Status tracking": "Seguimiento del estado", "Track a demonstration filing": "Seguimiento de una presentación de demostración",
  "Enter the tracking number and the access code you saved when you submitted.": "Ingrese el número de seguimiento y el código de acceso que guardó al enviar.",
  "Access code": "Código de acceso", "View status": "Ver el estado",
  "Those details did not match a filing. Check both values and try again.": "Esos datos no coinciden con ninguna presentación. Revise ambos valores e inténtelo de nuevo.",
  "Too many requests. Wait a few minutes and try again.": "Demasiadas solicitudes. Espere unos minutos e inténtelo de nuevo.",
  "Filing status": "Estado de la presentación", "Sign out": "Cerrar sesión", "Current status": "Estado actual", "History": "Historial", "Receipts": "Acuses",
  "Download signed receipt (JSON)": "Descargar el acuse firmado (JSON)", "Plain-text copy": "Copia en texto plano",
  "Corrections, complaints and withdrawal": "Correcciones, quejas y retiro", "None filed.": "No se ha presentado ninguna.", "Request type": "Tipo de solicitud",
  "Receipt correction": "Corrección del acuse", "Complaint about processing": "Queja sobre la tramitación", "Withdraw this filing": "Retirar esta presentación",
  "Statement": "Declaración", "Submit request": "Enviar solicitud", "Representative access": "Acceso de representante",
  "Let a representative view (or also supplement) this filing with their own code. You can revoke it at any time.":
    "Permita que un representante vea (o también complemente) esta presentación con su propio código. Puede revocarlo en cualquier momento.",
  "Representative label (synthetic)": "Nombre del representante (ficticio)", "Access": "Acceso", "View status and receipts": "Ver el estado y los acuses",
  "View and submit supplements": "Ver y enviar complementos", "Create representative code": "Crear código de representante", "Revoke": "Revocar", "revoked": "revocado",
  "Add a supplementary filing": "Agregar una presentación complementaria", "Supplements receive their own receipt and never change the original.":
    "Los complementos reciben su propio acuse y nunca modifican el original.", "Submit supplement": "Enviar complemento",
  "Notices and messages": "Avisos y mensajes", "No notices.": "No hay avisos.", "Reply to the fictional agency": "Responder a la agencia ficticia", "Send reply": "Enviar respuesta",
  "Deadlines (demonstration estimates)": "Plazos (estimaciones de demostración)", "None yet.": "Ninguno todavía.", "pending": "pendiente",
  "acknowledgement": "acuse de recibo", "information request": "solicitud de información", "defect": "deficiencia", "determination": "determinación",
  "general": "general", "claimant reply": "respuesta del solicitante", "accepted": "aceptada", "denied": "denegada",
  "signed correction notice": "aviso de corrección firmado", "receipt correction": "corrección del acuse", "processing complaint": "queja sobre la tramitación",
  "withdrawal": "retiro", "cured relates back": "subsanado con efecto retroactivo", "cured late": "subsanado fuera de plazo",
  "Share this code with your representative": "Comparta este código con su representante", "Representative code:": "Código de representante:",
  "Representative code": "Código de representante",
  "Shown once. Stored only as a salted hash. Revoke it from the status page at any time.": "Se muestra una sola vez. Solo se guarda como un hash con sal. Revóquelo desde la página de estado cuando quiera.",
  "Back to status →": "Volver al estado →",
  // statuses
  "Received (demo receipt issued)": "Recibida (acuse de demostración emitido)", "Delivered to fictional agency inbox": "Entregada a la bandeja de la agencia ficticia",
  "Routing escalated to staff": "Envío escalado al personal", "Under review": "En revisión", "Information requested": "Información solicitada", "Referred": "Remitida",
  "Closed": "Cerrada", "Withdrawn": "Retirada", "Withdrawal requested": "Retiro solicitado", "Receipt correction requested": "Corrección del acuse solicitada",
  "Complaint filed": "Queja presentada", "acknowledged": "acuse de recibo enviado", "processing": "en trámite", "under review": "en revisión",
  "under appeal review": "apelación en revisión", "under investigation": "en investigación", "information requested": "información solicitada",
  "defect notice issued": "aviso de deficiencia emitido", "cured": "subsanada", "routing overdue": "envío fuera de plazo", "deadline missed": "plazo incumplido",
  "deemed denied": "denegación presunta", "closed": "cerrada", "withdrawn": "retirada", "Demonstration receipt issued.": "Acuse de demostración emitido.",
  "Filed by the participant; the original record is unchanged.": "Presentado por el participante; el registro original no cambia.",
  "Delivered to the fictional demonstration agency inbox.": "Entregado a la bandeja de la agencia ficticia de demostración.",
  "open": "abierto", "met": "cumplido", "missed": "incumplido", "tolled": "suspendido", "cancelled": "cancelado", "your window": "su plazo", "agency clock": "plazo de la agencia",
  // verify
  "Independent verification": "Verificación independiente", "Verify a demonstration receipt": "Verificar un acuse de demostración",
  "Paste a signed receipt JSON document. Verification checks the Ed25519 signature against the": "Pegue un documento JSON de acuse firmado. La verificación comprueba la firma Ed25519 con las",
  "published keys": "claves publicadas", "and the hash-chained ledger. It reveals no filing content.": "y el registro encadenado por hash. No revela el contenido de la presentación.",
  "Signed receipt JSON": "JSON del acuse firmado", "Verify": "Verificar", "Valid demonstration receipt": "Acuse de demostración válido", "Not verified": "No verificado",
  "The text is not a signed receipt document.": "El texto no es un documento de acuse firmado.", "The receipt fields are malformed or altered.": "Los campos del acuse están mal formados o alterados.",
  "The signature block is malformed.": "El bloque de firma está mal formado.", "The receipt was not signed by a key this prototype publishes.": "El acuse no fue firmado con una clave publicada por este prototipo.",
  "The signature does not match the receipt fields. The receipt was altered or forged.": "La firma no coincide con los campos del acuse. El acuse fue alterado o falsificado.",
  "No matching ledger entry exists.": "No existe una entrada del registro que coincida.", "The receipt does not match its ledger entry.": "El acuse no coincide con su entrada del registro.",
  "This proves only these cryptographic facts. It does not show legal sufficiency or receipt by any government institution.":
    "Esto solo prueba estos hechos criptográficos. No demuestra suficiencia legal ni la recepción por ninguna institución del gobierno.",
  // assistance and unavailable
  "Public assistance": "Asistencia al público", "Getting help with the demonstration": "Cómo obtener ayuda con la demostración", "Accessible by design": "Accesible por diseño",
  "Every page works without JavaScript, with a keyboard and with screen readers. Pages are small for slow connections, and receipts have a":
    "Todas las páginas funcionan sin JavaScript, con teclado y con lectores de pantalla. Las páginas son ligeras para conexiones lentas y los acuses tienen una",
  "plain-text version": "versión en texto plano", "for low-bandwidth use and printing.": "para conexiones lentas y para imprimir.", "Language": "Idioma",
  "Representatives": "Representantes", "From the status page, a filer can create a separate, revocable code for a representative, who can view or also supplement the filing.":
    "Desde la página de estado, quien presenta puede crear un código separado y revocable para un representante, que podrá ver o también complementar la presentación.",
  "Human assistance": "Asistencia de personas", "A production service would list staffed phone, TTY and in-person options from the receiving institution. This demonstration has no staffed assistance line and no real agency contacts.":
    "Un servicio en producción indicaría las opciones de atención telefónica, TTY y presencial de la institución receptora. Esta demostración no tiene línea de asistencia atendida ni contactos reales de agencias.",
  "Emergencies": "Emergencias", "For an immediate danger, contact local emergency services. The demo's emergency flag only prioritizes fictional routing.":
    "Ante un peligro inmediato, comuníquese con los servicios de emergencia locales. La marca de emergencia de la demostración solo da prioridad al envío ficticio.",
  "Demo unavailable": "Demostración no disponible", "Demo filing is not configured": "La presentación de demostración no está configurada", "Temporarily unavailable": "No disponible temporalmente",
  "The demonstration storage service is unreachable. Nothing you submitted was saved and no filing date was preserved. Try again in a few minutes.":
    "No se puede acceder al almacenamiento de la demostración. No se guardó nada de lo que envió y no se preservó ninguna fecha de presentación. Inténtelo de nuevo en unos minutos.",
  "Filing guide": "Guía de presentación", "Español": "Español", "Información en español": "Información en español",
};

const ACCOUNT_ES = {
  "Account": "Cuenta", "Your account": "Su cuenta", "Recovery codes": "Códigos de recuperación", "Recovery": "Recuperación",
  "Optional account": "Cuenta opcional", "Sign in with a passkey": "Iniciar sesión con una llave de acceso",
  "An account is optional. It keeps your demonstration filings in one list. It uses a": "La cuenta es opcional. Reúne sus presentaciones de demostración en una lista. Usa una",
  "passkey": "llave de acceso",
  "(your device's screen lock or a security key). There is no password, and no email or phone number is required.":
    "(el bloqueo de pantalla de su dispositivo o una llave de seguridad). No hay contraseña y no se requiere correo electrónico ni teléfono.",
  "(your device&#39;s screen lock or a security key). There is no password, and no email or phone number is required.":
    "(el bloqueo de pantalla de su dispositivo o una llave de seguridad). No hay contraseña y no se requiere correo electrónico ni teléfono.",
  "Create an account": "Crear una cuenta", "Account nickname (synthetic, optional)": "Apodo de la cuenta (ficticio, opcional)",
  "Create account with a passkey": "Crear cuenta con una llave de acceso", "Save your recovery codes now": "Guarde ahora sus códigos de recuperación",
  "Each code works once if you lose your passkey. They are shown only once and stored only as hashes.":
    "Cada código sirve una vez si pierde su llave de acceso. Se muestran una sola vez y solo se guardan como hashes.",
  "I saved my codes. Continue to my account": "Guardé mis códigos. Continuar a mi cuenta", "Lost your passkey?": "¿Perdió su llave de acceso?",
  "Recovery code": "Código de recuperación", "Sign in with a recovery code": "Iniciar sesión con un código de recuperación",
  "Recovery by email or text message": "Recuperación por correo electrónico o mensaje de texto",
  "This demonstration has no email or SMS provider. Requests are recorded but nothing is sent. Use a recovery code.":
    "Esta demostración no tiene proveedor de correo electrónico ni de SMS. Las solicitudes se registran pero no se envía nada. Use un código de recuperación.",
  "Channel": "Canal", "Email": "Correo electrónico", "Text message": "Mensaje de texto", "Email or phone (synthetic)": "Correo electrónico o teléfono (ficticio)",
  "Request recovery message": "Solicitar mensaje de recuperación",
  "Passkeys need JavaScript. You can still track filings with a tracking number and access code, and sign in with a recovery code.":
    "Las llaves de acceso necesitan JavaScript. Puede seguir consultando presentaciones con el número de seguimiento y el código de acceso, e iniciar sesión con un código de recuperación.",
  "Your account (demonstration)": "Su cuenta (demostración)", "Your filings": "Sus presentaciones", "Linked filings": "Presentaciones vinculadas",
  "Open": "Abrir", "Unlink": "Desvincular", "No filings linked yet.": "Todavía no hay presentaciones vinculadas.", "Link a filing": "Vincular una presentación",
  "Link filing": "Vincular presentación", "Passkeys": "Llaves de acceso", "Remove": "Quitar", "Add another passkey": "Agregar otra llave de acceso",
  "Generate new recovery codes (old codes stop working)": "Generar nuevos códigos de recuperación (los anteriores dejan de funcionar)",
  "Signed-in sessions": "Sesiones iniciadas", "this session": "esta sesión", "Sign out this session": "Cerrar esta sesión",
  "Sign out everywhere": "Cerrar sesión en todas partes", "Save your new recovery codes": "Guarde sus nuevos códigos de recuperación",
  "Each code works once. They are shown only now and stored only as hashes. Your previous codes no longer work.":
    "Cada código sirve una vez. Solo se muestran ahora y se guardan solo como hashes. Sus códigos anteriores ya no funcionan.",
  "Back to my account →": "Volver a mi cuenta →", "Back →": "Volver →", "No message was sent": "No se envió ningún mensaje",
  "This demonstration has no email or SMS provider configured. Your request was recorded, but nothing was sent. Use one of your recovery codes instead.":
    "Esta demostración no tiene configurado un proveedor de correo electrónico ni de SMS. Su solicitud se registró, pero no se envió nada. Use uno de sus códigos de recuperación.",
  "The passkey could not be verified. Try again.": "No se pudo verificar la llave de acceso. Inténtelo de nuevo.", "That request expired. Try again.": "Esa solicitud venció. Inténtelo de nuevo.",
  "Those details did not match a filing you own. Use the tracking number and the original access code (not a representative code).":
    "Esos datos no coinciden con una presentación suya. Use el número de seguimiento y el código de acceso original (no un código de representante).",
  "That recovery code is not valid or was already used.": "Ese código de recuperación no es válido o ya se usó.",
  "You cannot remove your only passkey. Add another one first.": "No puede quitar su única llave de acceso. Agregue otra primero.",
  "That passkey is already registered.": "Esa llave de acceso ya está registrada.", "This account already has the maximum number of passkeys.": "Esta cuenta ya tiene el número máximo de llaves de acceso.",
  "Enter an email address or phone number.": "Ingrese un correo electrónico o un número de teléfono.", "passkey": "llave de acceso", "recovery code": "código de recuperación",
  "registration": "registro", "Tracking": "Seguimiento", "Fictional agency": "Agencia ficticia", "Status": "Estado", "Action": "Acción",
};
const ERRORS_ES = {
  "Choose one of the fictional demonstration agencies.": "Elija una de las agencias ficticias de demostración.",
  "That filing type is not accepted by the selected fictional agency.": "La agencia ficticia seleccionada no acepta ese tipo de presentación.",
  "Enter a subject of up to 200 characters.": "Ingrese un asunto de hasta 200 caracteres.", "Enter the filing text (up to 20,000 characters).": "Ingrese el texto de la presentación (hasta 20,000 caracteres).",
  "Enter a synthetic name (up to 120 characters).": "Ingrese un nombre ficticio (hasta 120 caracteres).", "Contact details are too long.": "Los datos de contacto son demasiado largos.",
  "An attachment name is invalid.": "El nombre de un adjunto no es válido.", "Attachments must be PDF, plain text, PNG or JPEG.": "Los adjuntos deben ser PDF, texto plano, PNG o JPEG.",
  "Attachments are limited to 5 MB each and 10 MB in total.": "Los adjuntos tienen un límite de 5 MB cada uno y 10 MB en total.", "Attach at most three files.": "Adjunte como máximo tres archivos.",
  "An attachment's content does not match its file type.": "El contenido de un adjunto no coincide con su tipo de archivo.",
  "The form expired. Reload the page and try again.": "El formulario venció. Vuelva a cargar la página e inténtelo de nuevo.",
  "This form was already submitted with different content. Reload the page to start a new filing.": "Este formulario ya se envió con otro contenido. Vuelva a cargar la página para iniciar una nueva presentación.",
  "Confirm all three statements before submitting.": "Confirme las tres declaraciones antes de enviar.",
  "Supplementary filings go to the same agency as the original.": "Las presentaciones complementarias van a la misma agencia que la original.",
  "The request could not be read. Reload the page and try again.": "No se pudo leer la solicitud. Vuelva a cargar la página e inténtelo de nuevo.",
  "The request could not be completed.": "No se pudo completar la solicitud.", "No unexpired draft matches that code.": "Ningún borrador vigente coincide con ese código.",
  "Enter a statement of up to 4,000 characters.": "Ingrese una declaración de hasta 4,000 caracteres.", "Enter a label of up to 80 characters.": "Ingrese un nombre de hasta 80 caracteres.",
  "Choose an access level.": "Elija un nivel de acceso.", "Choose a request type.": "Elija un tipo de solicitud.", "You do not have permission to do that.": "No tiene permiso para hacer eso.",
  "Classification markings were detected, so nothing was saved. Do not send classified information here.": "Se detectaron marcas de clasificación, por lo que no se guardó nada. No envíe información clasificada aquí.",
};
Object.assign(ES, ERRORS_ES, ACCOUNT_ES);

const FIELD_NAMES = { sumCertain: "suma determinada", incidentDate: "fecha del incidente", incidentLocation: "lugar del incidente", injuryType: "tipo de reclamación",
  claimCategory: "categoría de la reclamación", decisionReference: "referencia de la decisión", decisionDate: "fecha de la decisión", reliefSought: "reparación solicitada",
  recordsDescription: "descripción de los registros", requestReference: "solicitud original", determinationDate: "fecha de la respuesta", appealBasis: "motivo de la apelación",
  complaintSubject: "asunto de la queja", requestedAction: "acción solicitada", amountClaimed: "monto reclamado", dateRangeEnd: "registros hasta", dateRangeStart: "registros desde" };
const DEADLINE_ES = { "Agency response to records request (demo: 20 business days)": "Respuesta de la agencia a la solicitud de registros (demo: 20 días hábiles)",
  "Window to appeal a records determination (demo: 90 calendar days)": "Plazo para apelar una determinación de registros (demo: 90 días naturales)",
  "Decision on records appeal (demo: 20 business days)": "Decisión sobre la apelación de registros (demo: 20 días hábiles)",
  "Agency final disposition of tort claim before deemed denial (demo: 6 months)": "Resolución final de la agencia sobre la reclamación por daños antes de la denegación presunta (demo: 6 meses)",
  "Window after a tort denial (demo: 6 months)": "Plazo tras la denegación de una reclamación por daños (demo: 6 meses)",
  "Decision on administrative claim (demo: 60 calendar days)": "Decisión sobre la reclamación administrativa (demo: 60 días naturales)",
  "Decision on administrative appeal (demo: 90 calendar days)": "Decisión sobre la apelación administrativa (demo: 90 días naturales)",
  "Acknowledge complaint or petition (demo: 10 business days)": "Acuse de recibo de la queja o petición (demo: 10 días hábiles)",
  "Claimant cure period after a defect notice (demo: 30 calendar days)": "Plazo para subsanar tras un aviso de deficiencia (demo: 30 días naturales)" };
Object.assign(ES, DEADLINE_ES);

const tr = (s) => ES[s] ?? s;
const TEMPLATES = [
  [/^(.+) \| Federal Filing Prototype \(demo\)$/, (m) => `${tr(m[1])} | Prototipo de presentación federal (demo)`],
  [/^Details for (.+)$/, (m) => `Datos para ${tr(m[1])}`],
  [/^(.+) \(optional\)$/, (m) => `${tr(m[1])} (opcional)`],
  [/^(Demonstration .+ \(fictional\)): (.+)$/, (m) => `${tr(m[1])}: ${m[2].split(", ").map(tr).join(", ")}`],
  [/^(.+?) · due (\S+) \(Eastern\) · (\w+) · (your window|agency clock)$/, (m) => `${tr(m[1])} · vence ${m[2]} (hora del Este) · ${tr(m[3])} · ${tr(m[4])}`],
  [/^Deadline estimates use (\S+)\. They are not legal deadlines\.$/, (m) => `Las estimaciones de plazos usan ${m[1]}. No son plazos legales.`],
  [/^\((\d+) part\(s\), (\d+) bytes\)$/, (m) => `(${m[1]} parte(s), ${m[2]} bytes)`],
  [/^cure by (\S+)$/, (m) => `subsanar antes de ${m[1]}`],
  [/^Cure by (\S+) \(Eastern\)\.$/, (m) => `Subsanar antes del ${m[1]} (hora del Este).`],
  [/^· (\S+) · from (the fictional agency|claimant|representative)( ·)?$/, (m) => `· ${m[1]} · de ${m[2] === "the fictional agency" ? "la agencia ficticia" : m[2] === "claimant" ? "el solicitante" : "el representante"}${m[3] ?? ""}`],
  [/^· ([^:]+?)(?:: (.*))?$/, (m) => `· ${translateSegment(m[1])}${m[2] !== undefined ? `: ${translateSegment(m[2])}` : ""}`],
  [/^(.+?) · filed (\S+) · (.+)$/, (m) => `${tr(m[1])} · presentada ${m[2]} · ${tr(m[3])}`],
  [/^Complete the required field (?:"|&quot;)(\w[\w ]*)(?:"|&quot;)\.$/, (m) => `Complete el campo obligatorio «${FIELD_NAMES[camel(m[1])] ?? m[1]}».`],
  [/^Check the field (?:"|&quot;)(\w[\w ]*)(?:"|&quot;)\.$/, (m) => `Revise el campo «${FIELD_NAMES[camel(m[1])] ?? m[1]}».`],
  [/^(.+) · (view|view_supplement) ·$/, (m) => `${m[1]} · ${m[2] === "view" ? "ver" : "ver y complementar"} ·`],
  [/^(.+) · (view|view_supplement) · revoked$/, (m) => `${m[1]} · ${m[2] === "view" ? "ver" : "ver y complementar"} · revocado`],
  [/^Status tracking · representative access \((\w+)\)$/, (m) => `Seguimiento del estado · acceso de representante (${m[1] === "view" ? "ver" : "ver y complementar"})`],
  [/^Only (\d+) recovery codes left\. Generate new ones below\.$/, (m) => `Solo quedan ${m[1]} códigos de recuperación. Genere nuevos abajo.`],
  [/^(\d+) unused recovery codes\.$/, (m) => `${m[1]} códigos de recuperación sin usar.`],
  [/^(\d+) new$/, (m) => `${m[1]} nuevos`],
  [/^(Passkey \d+) · added (\S+)(?: · last used (\S+))?$/, (m) => `${m[1].replace("Passkey", "Llave de acceso")} · agregada ${m[2]}${m[3] ? ` · último uso ${m[3]}` : ""}`],
  [/^(passkey|recovery code|registration) · since (\S+)(?: ·)?$/, (m) => `${tr(m[1])} · desde ${m[2]}${m[0].endsWith(" ·") ? " ·" : ""}`],
  [/^This prototype's key$/, () => "La clave de este prototipo"],
  [/^signed these exact fields, and ledger entry #(\d+) matches\. Received$/, (m) => `firmó exactamente estos campos y la entrada del registro n.º ${m[1]} coincide. Recibido`],
  [/^; manifest$/, () => "; manifiesto"],
];
function camel(words) { return words.trim().split(" ").map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join(""); }

export function translateSegment(text) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  let out = ES[trimmed];
  if (out === undefined) for (const [re, fn] of TEMPLATES) { const m = re.exec(trimmed); if (m) { out = fn(m); break; } }
  return out === undefined ? text : text.replace(trimmed, out);
}

/** Translates static UI text in a rendered page. Leaves <pre> blocks (signed JSON, filing text) untouched. */
export function translateHtml(html, lang) {
  if (lang !== "es") return html;
  const parts = html.split(/(<pre[\s>][\s\S]*?<\/pre>)/);
  return parts.map((part) => part.startsWith("<pre") ? part : part
    .replace('<html lang="en">', '<html lang="es">')
    .replace(/(aria-label|placeholder)="([^"]*)"/g, (all, attr, v) => `${attr}="${translateSegment(v)}"`)
    .replace(/<title>([^<]*)<\/title>/, (all, v) => `<title>${translateSegment(v)}</title>`)
    .replace(/>([^<>]+)</g, (all, v) => `>${translateSegment(v)}<`)
    .replace('href="/idioma/es">Español<', 'href="/language/en" lang="en">English<')).join("");
}

export const SPANISH_CATALOG_SIZE = Object.keys(ES).length;

/** Request language: explicit cookie first, then Accept-Language. */
export function requestLanguage(req, cookies) {
  if (cookies.ufr_lang === "es" || cookies.ufr_lang === "en") return cookies.ufr_lang;
  const accept = String(req.headers["accept-language"] ?? "").toLowerCase();
  const first = accept.split(",")[0]?.trim() ?? "";
  return first.startsWith("es") ? "es" : "en";
}
