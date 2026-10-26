import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * Low-poly 3D showroom scene: a stylised car on a glowing grid,
 * lit by two coloured lights, with slow auto-rotation + pointer parallax.
 */
export default function ThreeHero({ height = '100%' }) {
  const mount = useRef(null)

  useEffect(() => {
    const el = mount.current
    if (!el) return
    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x06090f, 0.055)

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    camera.position.set(5.4, 2.6, 6.4)
    camera.lookAt(0, 0.55, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    el.appendChild(renderer.domElement)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = '100%'
    renderer.domElement.style.display = 'block'

    const car = new THREE.Group()

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222b3a, metalness: 0.92, roughness: 0.24 })
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0b1119, metalness: 0.6, roughness: 0.1, transparent: true, opacity: 0.92 })
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xc6f24e, emissive: 0xc6f24e, emissiveIntensity: 1.5, metalness: 0.4, roughness: 0.4 })
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.95 })
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xbfc7d2, metalness: 1, roughness: 0.28 })

    // chassis
    const base = new THREE.Mesh(new THREE.BoxGeometry(4.15, 0.52, 1.92), bodyMat)
    base.position.y = 0.63
    base.castShadow = true
    car.add(base)

    // hood + trunk taper
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.3, 1.82), bodyMat)
    hood.position.set(1.42, 0.98, 0)
    hood.castShadow = true
    car.add(hood)

    const trunk = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.3, 1.82), bodyMat)
    trunk.position.set(-1.62, 0.98, 0)
    trunk.castShadow = true
    car.add(trunk)

    // cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.62, 1.74), glassMat)
    cabin.position.set(-0.12, 1.4, 0)
    cabin.castShadow = true
    car.add(cabin)

    // roof
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.84, 0.12, 1.68), bodyMat)
    roof.position.set(-0.16, 1.74, 0)
    car.add(roof)

    // lightbar front / rear
    const frontLight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 1.5), accentMat)
    frontLight.position.set(2.08, 0.86, 0)
    car.add(frontLight)

    const rearLight = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 1.35), new THREE.MeshStandardMaterial({ color: 0xff4d6d, emissive: 0xff4d6d, emissiveIntensity: 1.4 }))
    rearLight.position.set(-2.1, 0.9, 0)
    car.add(rearLight)

    // side accent strips
    ;[1, -1].forEach((s) => {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.045, 0.02), accentMat)
      strip.position.set(0, 0.62, s * 0.965)
      car.add(strip)
    })

    // wheels
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.26, 24)
    const rimGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.28, 12)
    const wheels = []
    ;[[1.32, 0.93], [1.32, -0.93], [-1.34, 0.93], [-1.34, -0.93]].forEach(([x, z]) => {
      const tyre = new THREE.Mesh(wheelGeo, tyreMat)
      tyre.rotation.x = Math.PI / 2
      tyre.position.set(x, 0.42, z)
      tyre.castShadow = true
      const rim = new THREE.Mesh(rimGeo, rimMat)
      rim.rotation.x = Math.PI / 2
      rim.position.copy(tyre.position)
      car.add(tyre, rim)
      wheels.push(tyre, rim)
    })

    // ground shadow catcher + grid
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x070b11, roughness: 1, metalness: 0 })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = 0.01
    ground.receiveShadow = true
    scene.add(ground)

    const grid = new THREE.GridHelper(34, 34, 0x2a3a25, 0x14202c)
    grid.material.transparent = true
    grid.material.opacity = 0.5
    grid.position.y = 0.02
    scene.add(grid)

    // accent halo ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.5, 3.54, 64),
      new THREE.MeshBasicMaterial({ color: 0xc6f24e, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.04
    scene.add(ring)

    // floating cubes (data motes)
    const motes = new THREE.Group()
    for (let i = 0; i < 26; i++) {
      const s = 0.03 + Math.random() * 0.07
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshStandardMaterial({
          color: i % 4 === 0 ? 0xc6f24e : 0x4cc9f0,
          emissive: i % 4 === 0 ? 0xc6f24e : 0x4cc9f0,
          emissiveIntensity: 1.2,
          transparent: true,
          opacity: 0.75,
        })
      )
      const a = Math.random() * Math.PI * 2
      const r = 3 + Math.random() * 4.4
      m.position.set(Math.cos(a) * r, 0.5 + Math.random() * 3.6, Math.sin(a) * r)
      m.userData.speed = 0.15 + Math.random() * 0.5
      m.userData.y0 = m.position.y
      motes.add(m)
    }
    scene.add(motes)

    car.position.y = 0.03
    scene.add(car)

    // lights
    scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x0a0f18, 0.55))
    const key = new THREE.DirectionalLight(0xffffff, 1.7)
    key.position.set(5, 8, 5)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 30
    key.shadow.camera.left = -8
    key.shadow.camera.right = 8
    key.shadow.camera.top = 8
    key.shadow.camera.bottom = -8
    scene.add(key)

    const l1 = new THREE.PointLight(0xc6f24e, 46, 22)
    l1.position.set(-4, 2.4, 3.4)
    scene.add(l1)
    const l2 = new THREE.PointLight(0x4cc9f0, 40, 22)
    l2.position.set(4.6, 2, -3.4)
    scene.add(l2)

    const resize = () => {
      const w = el.clientWidth || 600
      const h = el.clientHeight || 500
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let px = 0, py = 0, cx = 0, cy = 0
    const onMove = (e) => {
      const r = el.getBoundingClientRect()
      px = ((e.clientX - r.left) / r.width - 0.5) * 2
      py = ((e.clientY - r.top) / r.height - 0.5) * 2
    }
    window.addEventListener('pointermove', onMove)

    let raf
    const clock = new THREE.Clock()
    const animate = () => {
      const t = clock.getElapsedTime()
      car.rotation.y = Math.sin(t * 0.28) * 0.42 + t * 0.12
      car.position.y = 0.03 + Math.sin(t * 0.9) * 0.035
      ring.scale.setScalar(1 + Math.sin(t * 1.1) * 0.02)
      ring.material.opacity = 0.22 + Math.sin(t * 1.4) * 0.12
      motes.children.forEach((m, i) => {
        m.position.y = m.userData.y0 + Math.sin(t * m.userData.speed + i) * 0.32
        m.rotation.x += 0.01
        m.rotation.y += 0.014
      })
      cx += (px - cx) * 0.035
      cy += (py - cy) * 0.035
      camera.position.x = 5.4 + cx * 1.1
      camera.position.y = 2.6 - cy * 0.7
      camera.lookAt(0, 0.62, 0)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('pointermove', onMove)
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) Array.isArray(o.material) ? o.material.forEach((m) => m.dispose()) : o.material.dispose()
      })
      renderer.dispose()
      if (renderer.domElement.parentNode === el) el.removeChild(renderer.domElement)
    }
  }, [])

  return <div ref={mount} style={{ width: '100%', height, minHeight: 260 }} />
}
