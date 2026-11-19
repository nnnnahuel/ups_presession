// Frases de la voz de la pantalla /screen/v2.
//
// Este archivo lo leen la pantalla y el servidor: /screen/tts solo genera audio
// para estas frases (más las viejas de /screen). Cambiar un texto acá alcanza;
// la primera vez que suene el texto nuevo se paga un audio a ElevenLabs y queda
// guardado en la base.
export const VOICE_LINES = {
  count5: "Cinco",
  count4: "Cuatro",
  count3: "Tres",
  count2: "Dos",
  count1: "Uno",
  start: "Comienza la sesión",
  minute45: "Quedan diez minutos",
  end: "Sesión completa. Cinco minutos para liberar la sala",
};
