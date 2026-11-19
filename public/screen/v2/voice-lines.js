// Frases de la voz de la pantalla /screen/v2.
//
// Cada clave es un audio grabado: public/screen/v2/voice/<clave>.mp3 (con el efecto
// de anunciador ya aplicado). Este archivo es el registro de qué dice cada uno; la
// pantalla usa las claves para cargarlos. Cambiar un texto acá NO cambia lo que
// suena: hay que grabar y reemplazar el archivo.
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
