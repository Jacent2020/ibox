(function () {
  'use strict';

  var MAX_SIDE = 1920; // 壓縮後照片最長邊
  var QUALITY = 0.82;

  // 手機版選單
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // 刪除等動作的確認視窗
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // 表格整列可點擊
  document.querySelectorAll('tr[data-href]').forEach(function (tr) {
    tr.addEventListener('click', function (e) {
      if (e.target.closest('a, button, input, form')) return;
      window.location.href = tr.getAttribute('data-href');
    });
  });

  // GPS 定位
  document.querySelectorAll('[data-geo]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var form = btn.closest('form');
      var status = form.querySelector('[data-geo-status]');
      if (!navigator.geolocation) {
        status.textContent = '此裝置不支援定位。';
        return;
      }
      status.textContent = '定位中…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        var lat = pos.coords.latitude.toFixed(6);
        var lng = pos.coords.longitude.toFixed(6);
        form.querySelector('[name=latitude]').value = lat;
        form.querySelector('[name=longitude]').value = lng;
        status.textContent = '已記錄 GPS 座標：' + lat + ', ' + lng + '（誤差約 ' + Math.round(pos.coords.accuracy) + ' 公尺）';
      }, function (err) {
        status.textContent = '無法取得位置：' + (err.code === 1 ? '請允許瀏覽器使用定位權限。' : err.message);
      }, { enableHighAccuracy: true, timeout: 15000 });
    });
  });

  // 照片選取：可多次點選累加（手機拍一張、再拍一張…），每張可單獨移除
  var MAX_PER_STAGE = 20;
  function fileKey(f) { return f.name + '|' + f.size + '|' + f.lastModified; }

  document.querySelectorAll('input[type=file][data-preview]').forEach(function (input) {
    var label = input.closest('label');
    var labelText = label ? label.firstChild.textContent.trim() : '';
    var box = input.closest('.photo-input, form').querySelector('.previews');
    var autosubmit = input.hasAttribute('data-autosubmit');
    input._files = [];

    function render() {
      if (box) {
        box.innerHTML = '';
        input._files.forEach(function (file, i) {
          var item = document.createElement('div');
          item.className = 'preview-item';
          var img = document.createElement('img');
          img.alt = file.name;
          img.src = URL.createObjectURL(file);
          item.appendChild(img);
          if (!autosubmit) {
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'preview-del';
            del.setAttribute('aria-label', '移除這張');
            del.textContent = '×';
            del.addEventListener('click', function () {
              input._files.splice(i, 1);
              render();
            });
            item.appendChild(del);
          }
          box.appendChild(item);
        });
      }
      if (label) {
        var n = input._files.length;
        label.firstChild.textContent = n ? labelText + '（已選 ' + n + ' 張，點此再加）' : labelText;
      }
    }

    input.addEventListener('change', function () {
      var seen = {};
      input._files.forEach(function (f) { seen[fileKey(f)] = true; });
      var over = false;
      Array.prototype.forEach.call(input.files, function (f) {
        if (seen[fileKey(f)]) return;
        if (input._files.length >= MAX_PER_STAGE) { over = true; return; }
        input._files.push(f);
        seen[fileKey(f)] = true;
      });
      if (over) window.alert('每個階段最多 ' + MAX_PER_STAGE + ' 張照片。');
      render();
      if (autosubmit) {
        if (input._files.length) input.form.requestSubmit ? input.form.requestSubmit() : input.form.submit();
      } else {
        input.value = ''; // 清空後才能再次選取（含同一張），已選的照片保留在 _files
      }
    });
  });

  // 以 canvas 縮小照片，降低行動網路上傳量；失敗時回傳原檔
  function shrink(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || !window.createImageBitmap) {
      return Promise.resolve(file);
    }
    return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type === 'image/jpeg') return file;
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) {
          if (!blob || blob.size >= file.size) return resolve(file);
          var name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
          resolve(new File([blob], name, { type: 'image/jpeg' }));
        }, 'image/jpeg', QUALITY);
      });
    }).catch(function () { return file; });
  }

  // 含照片的表單改以 XHR 送出：可壓縮照片並顯示上傳進度
  document.querySelectorAll('form[data-upload-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.FormData || !window.Promise) return; // 舊瀏覽器走一般送出
      if (!form.checkValidity()) return;
      e.preventDefault();

      var submitBtns = form.querySelectorAll('button[type=submit], [data-submit]');
      var progress = form.querySelector('[data-progress]');
      var bar = progress && progress.querySelector('.progress-bar');
      var text = progress && progress.querySelector('span');
      submitBtns.forEach(function (b) { b.disabled = true; });
      if (progress) { progress.hidden = false; text.textContent = '照片處理中…'; }

      var data = new FormData();
      var jobs = [];
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.disabled) return;
        if (el.type === 'file') {
          Array.prototype.forEach.call(el._files || el.files, function (f) {
            jobs.push(shrink(f).then(function (out) { return [el.name, out]; }));
          });
        } else if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) {
          // 未勾選不送
        } else if (el.tagName === 'SELECT' && el.multiple) {
          Array.prototype.forEach.call(el.selectedOptions, function (o) { data.append(el.name, o.value); });
        } else if (el.type !== 'submit' && el.type !== 'button') {
          data.append(el.name, el.value);
        }
      });

      Promise.all(jobs).then(function (files) {
        files.forEach(function (pair) { data.append(pair[0], pair[1], pair[1].name); });
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.upload.onprogress = function (ev) {
          if (!ev.lengthComputable || !progress) return;
          var pct = Math.round((ev.loaded / ev.total) * 100);
          bar.style.width = pct + '%';
          text.textContent = '上傳中 ' + pct + '%';
        };
        xhr.onload = function () {
          var json = null;
          try { json = JSON.parse(xhr.responseText); } catch (err) { /* 非 JSON：錯誤頁 */ }
          if (json && json.redirect) {
            window.location.href = json.redirect;
          } else {
            // 驗證失敗等情況，直接顯示伺服器回傳的頁面
            document.open();
            document.write(xhr.responseText);
            document.close();
          }
        };
        xhr.onerror = function () {
          if (progress) text.textContent = '網路連線中斷，請確認訊號後再試一次。';
          submitBtns.forEach(function (b) { b.disabled = false; });
        };
        xhr.send(data);
      });
    });
  });

  // 簡易燈箱
  document.querySelectorAll('a[data-lightbox]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var box = document.createElement('div');
      box.className = 'lightbox';
      box.innerHTML = '<button type="button" aria-label="關閉">×</button>';
      var img = document.createElement('img');
      img.src = a.href;
      box.appendChild(img);
      box.addEventListener('click', function () { box.remove(); });
      document.body.appendChild(box);
    });
  });
})();
