import {
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder
} from '@jubbio/core';
import { config } from '../config.js';
import { komutlar } from './komutlar.js';
import { manager } from '../music/manager.js';
import { favoriler } from '../music/favoriler.js';
import { aramaOnbellek } from '../utils/onbellek.js';
import { kisalt } from '../utils/format.js';
import { panelOlustur, kuyrukEmbed, bilgiEmbed, hataEmbed } from '../ui/panel.js';
import {
  kullaniciSesKanali, kullaniciId, hata, sarkiEkle, paketEkle,
  favoriEkleIslem, favoriListeIslem
} from './ortak.js';

/** Kullanıcı botla farklı bir kanaldaysa true. Kanal okunamazsa engellemez. */
function farkliKanalda(i, gp) {
  const kk = kullaniciSesKanali(i);
  console.log('[kanal kontrol]', JSON.stringify(kk), JSON.stringify(gp.voiceChannelId));
  return Boolean(kk && gp.voiceChannelId && String(kk) !== String(gp.voiceChannelId));
}

/** Butona/menüye basılınca mesajı yerinde güncelle. */
async function guncelle(i, payload) {
  if (typeof i.update === 'function') return i.update(payload);
  await i.deferUpdate?.();
  return i.editReply?.(payload);
}

// Panel butonlarının yaptığı işler
const butonlar = {
  pause: (gp) => (gp.paused ? gp.devamEt() : gp.duraklat()),
  skip: (gp) => gp.gec(),
  loop: (gp) => gp.donguDegistir(),
  shuffle: (gp) => gp.karistir(),
  volu: (gp) => gp.sesAyarla(gp.volume + config.sesAdimi),
  vold: (gp) => gp.sesAyarla(gp.volume - config.sesAdimi),
  clear: (gp) => gp.temizle()
};

async function butonIsle(i) {
  const eylem = i.customId.slice(2);

  // "Şarkı ekle" → pencere (modal) aç. Oturum olmasa da çalışır.
  if (eylem === 'add') {
    if (!kullaniciSesKanali(i)) return hata(i, 'Önce bir ses kanalına katıl!');
    const modal = new ModalBuilder().setCustomId('m:addmodal').setTitle('Şarkı ekle');
    const girdi = new TextInputBuilder()
      .setCustomId('sarki')
      .setLabel('Şarkı adı, YouTube veya Spotify linki')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(300);
    modal.addComponents(new ActionRowBuilder().addComponents(girdi));
    return i.showModal(modal);
  }

  // Favoriler (oturum gerektirmez)
  if (eylem === 'favekle') return favoriEkleIslem(i);
  if (eylem === 'favliste') return favoriListeIslem(i);

  const gp = manager.al(i.guildId);
  if (!gp) return hata(i, 'Bu oturum bitmiş. `/play` ile yeniden başlat.');
  if (farkliKanalda(i, gp)) {
    return hata(i, 'Bu paneli kullanmak için botla **aynı ses kanalında** olmalısın.');
  }

  if (eylem === 'queue') {
    return i.reply({ embeds: [kuyrukEmbed(gp)], ephemeral: true });
  }

  if (eylem === 'stop') {
    gp.durdurCal(); // kanalda kalır; 1 dk içinde yeni şarkı gelmezse çıkar
    return guncelle(i, panelOlustur(gp));
  }

  const is = butonlar[eylem];
  if (!is) return;
  is(gp);

  if (eylem === 'skip') await new Promise((r) => setTimeout(r, 700));
  return guncelle(i, panelOlustur(gp));
}

// ---- /search menüsünden seçim
async function aramaSecildi(i, ctx) {
  const anahtar = `${i.guildId}:${kullaniciId(i)}`;
  const kayit = aramaOnbellek.al(anahtar);
  if (!kayit) return hata(i, 'Bu arama senin değil ya da süresi doldu. `/search` ile yeniden ara.');

  const secim = kayit.sonuclar[Number(i.values?.[0])];
  if (!secim) return hata(i, 'Geçersiz seçim.');
  if (!kullaniciSesKanali(i)) return hata(i, 'Önce bir ses kanalına katıl!');

  aramaOnbellek.sil(anahtar);
  await guncelle(i, {
    embeds: [bilgiEmbed(`⏳ **${kisalt(secim.baslik, 80)}** ekleniyor…`)],
    components: []
  });
  return sarkiEkle(i, ctx, secim.sorgu);
}

// ---- /favoriler menüsünden seçim
async function favoriSecildi(i, ctx) {
  const liste = favoriler.liste(kullaniciId(i));
  if (!liste.length) return hata(i, 'Favori listen boş.');
  if (!kullaniciSesKanali(i)) return hata(i, 'Önce bir ses kanalına katıl!');

  const secim = i.values?.[0];
  const secilen = secim === 'hepsi' ? liste : [liste[Number(secim)]].filter(Boolean);
  if (!secilen.length) return hata(i, 'Geçersiz seçim.');

  await i.deferReply();
  return paketEkle(i, ctx, secilen, secim === 'hepsi' ? 'Favorilerim' : secilen[0].baslik);
}

async function menuIsle(i, ctx) {
  if (i.customId === 'm:sec') return aramaSecildi(i, ctx);
  if (i.customId === 'm:favsec') return favoriSecildi(i, ctx);

  // m:jump → kuyruktan bir şarkıya atla
  const gp = manager.al(i.guildId);
  if (!gp) return hata(i, 'Bu oturum bitmiş.');
  if (farkliKanalda(i, gp)) {
    return hata(i, 'Botla **aynı ses kanalında** olmalısın.');
  }
  gp.atla(Number(i.values?.[0]));
  await new Promise((r) => setTimeout(r, 700));
  return guncelle(i, panelOlustur(gp));
}

async function modalIsle(i, ctx) {
  const sorgu = (i.fields?.getTextInputValue?.('sarki') ?? '').trim();
  if (!sorgu) return hata(i, 'Boş bir şey yazdın.');
  if (!kullaniciSesKanali(i)) return hata(i, 'Önce bir ses kanalına katıl!');
  await i.deferReply();
  return sarkiEkle(i, ctx, sorgu);
}

const komutAdi = (k) => k.data?.toJSON?.().name ?? k.data?.name;

/** Bota gelen HER etkileşim buraya düşer. */
export async function etkilesimIsle(i, ctx) {
  try {
    // ---- panel bileşenleri (customId "m:" ile başlar)
    if (typeof i.customId === 'string' && i.customId.startsWith('m:')) {
      if (i.customId === 'm:addmodal') return await modalIsle(i, ctx);
      if (i.values) return await menuIsle(i, ctx);
      return await butonIsle(i, ctx);
    }

    // ---- slash komutları
    const komutMu = i.isChatInputCommand?.() || i.isCommand?.() || Boolean(i.commandName);
    if (!komutMu) return;

    const komut = komutlar.find((k) => komutAdi(k) === i.commandName);
    if (!komut) return console.log('[komut listede yok]', i.commandName);

    if (!i.guildId) {
      return i.reply({ embeds: [hataEmbed('Bu komut sadece sunucuda çalışır.')], ephemeral: true });
    }
    await komut.run(i, ctx);
  } catch (e) {
    console.error('[etkileşim hatası]', e);
    const cevap = { embeds: [hataEmbed(`Bir hata oluştu: ${e.message}`)], ephemeral: true };
    try {
      if (i.deferred || i.replied) await i.editReply?.({ embeds: cevap.embeds });
      else await i.reply(cevap);
    } catch {}
  }
}